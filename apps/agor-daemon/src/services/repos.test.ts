import path from 'node:path';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { ReposService } from './repos';

const mockCloneRepo = vi.fn();
const mockIsValidGitRepo = vi.fn();
const mockMkdir = vi.fn();

vi.mock('@agor/core/git', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/git')>('@agor/core/git');
  return {
    ...actual,
    cloneRepo: mockCloneRepo,
    isValidGitRepo: mockIsValidGitRepo,
    listWorktrees: vi.fn().mockResolvedValue([]),
    simpleGit: vi.fn(() => ({
      fetch: vi.fn(),
      branch: vi.fn().mockResolvedValue({ all: [] }),
    })),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdir: mockMkdir,
  };
});

describe('ReposService.createWorktree - repo cache reconciliation', () => {
  dbTest('auto-heals missing repo cache before creating worktree', async ({ db }) => {
    mockIsValidGitRepo.mockReset();
    mockCloneRepo.mockReset();
    mockMkdir.mockReset();

    mockIsValidGitRepo.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockCloneRepo.mockResolvedValue({
      path: '/tmp/repos/org-repo',
      repoName: 'repo',
      defaultBranch: 'main',
    });
    mockMkdir.mockResolvedValue(undefined);

    const worktreesService = {
      create: vi.fn(async (data: Record<string, unknown>) => ({
        worktree_id: '550e8400-e29b-41d4-a716-446655440010',
        others_fs_access: 'read',
        ...data,
      })),
    };

    const app = {
      service: (name: string) => {
        if (name === 'worktrees') return worktreesService;
        throw new Error(`Unexpected service lookup: ${name}`);
      },
    } as any;

    const service = new ReposService(db, app);
    const repo = await service.create({
      repo_type: 'remote',
      slug: 'org/repo',
      name: 'repo',
      remote_url: 'https://github.com/org/repo.git',
      local_path: '/tmp/repos/org-repo',
      default_branch: 'main',
    });

    const result = await service.createWorktree(repo.repo_id, {
      name: 'heal-test',
      ref: 'main',
      createBranch: false,
    });

    expect(mockMkdir).toHaveBeenCalledWith(path.dirname('/tmp/repos/org-repo'), {
      recursive: true,
    });
    expect(mockCloneRepo).toHaveBeenCalledWith({
      url: 'https://github.com/org/repo.git',
      targetDir: '/tmp/repos/org-repo',
    });
    expect(worktreesService.create).toHaveBeenCalledTimes(1);
    expect(result.name).toBe('heal-test');
  });

  dbTest('fails fast when repo cache cannot be restored', async ({ db }) => {
    mockIsValidGitRepo.mockReset();
    mockCloneRepo.mockReset();
    mockMkdir.mockReset();

    mockIsValidGitRepo.mockResolvedValue(false);
    mockCloneRepo.mockResolvedValue({
      path: '/tmp/repos/broken',
      repoName: 'broken',
      defaultBranch: 'main',
    });
    mockMkdir.mockResolvedValue(undefined);

    const worktreesService = {
      create: vi.fn(),
    };

    const app = {
      service: (name: string) => {
        if (name === 'worktrees') return worktreesService;
        throw new Error(`Unexpected service lookup: ${name}`);
      },
    } as any;

    const service = new ReposService(db, app);
    const repo = await service.create({
      repo_type: 'remote',
      slug: 'org/broken',
      name: 'broken',
      remote_url: 'https://github.com/org/broken.git',
      local_path: '/tmp/repos/broken',
      default_branch: 'main',
    });

    await expect(
      service.createWorktree(repo.repo_id, {
        name: 'should-fail',
        ref: 'main',
        createBranch: false,
      })
    ).rejects.toThrow('Repository cache could not be restored');

    expect(worktreesService.create).not.toHaveBeenCalled();
  });
});
