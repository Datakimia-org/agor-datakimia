import { RepoRepository } from '@agor/core/db';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { WorktreesService } from './worktrees';

const mockSpawnExecutor = vi.fn();
const mockResolveGitImpersonationForWorktree = vi.fn();

vi.mock('../utils/spawn-executor.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/spawn-executor.js')>(
    '../utils/spawn-executor.js'
  );
  return {
    ...actual,
    spawnExecutor: mockSpawnExecutor,
    getDaemonUrl: vi.fn(() => 'http://localhost:3030'),
  };
});

vi.mock('../utils/git-impersonation.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/git-impersonation.js')>(
    '../utils/git-impersonation.js'
  );
  return {
    ...actual,
    resolveGitImpersonationForWorktree: mockResolveGitImpersonationForWorktree,
  };
});

describe('WorktreesService.archiveOrDelete - delete failure semantics', () => {
  dbTest('records filesystem failure state when delete executor fails', async ({ db }) => {
    mockSpawnExecutor.mockReset();
    mockResolveGitImpersonationForWorktree.mockReset();
    mockResolveGitImpersonationForWorktree.mockResolvedValue('agor');

    mockSpawnExecutor.mockImplementation((_payload, options) => {
      options?.onExit?.(1);
    });

    const sessionsService = {
      find: vi.fn().mockResolvedValue([]),
      patch: vi.fn(),
    };

    const app = {
      service: (name: string) => {
        if (name === 'sessions') return sessionsService;
        if (name === 'board-objects') {
          return {
            findByWorktreeId: vi.fn(),
            create: vi.fn(),
            remove: vi.fn(),
          };
        }
        throw new Error(`Unexpected service lookup: ${name}`);
      },
      sessionTokenService: {
        generateToken: vi.fn().mockResolvedValue('token'),
      },
    } as any;

    const repoRepo = new RepoRepository(db);
    const repo = await repoRepo.create({
      repo_type: 'remote',
      slug: 'org/repo',
      name: 'repo',
      remote_url: 'https://github.com/org/repo.git',
      local_path: '/tmp/repos/org-repo',
      default_branch: 'main',
    });

    const service = new WorktreesService(db, app);
    const worktree = await service.create({
      repo_id: repo.repo_id,
      name: 'wt-delete-failure',
      path: '/tmp/worktrees/org/repo/wt-delete-failure',
      ref: 'main',
      new_branch: false,
      worktree_unique_id: 1,
      created_by: 'anonymous',
      last_used: new Date().toISOString(),
    });

    await service.archiveOrDelete(
      worktree.worktree_id,
      { metadataAction: 'archive', filesystemAction: 'deleted' },
      {}
    );

    // Allow async token->spawn->patch chain to settle.
    await Promise.resolve();
    await Promise.resolve();

    const updated = await service.get(worktree.worktree_id);
    expect(updated.filesystem_status).toBe('failed');
    expect(updated.archived).toBe(true);
  });
});
