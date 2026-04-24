import { describe, expect, it, vi } from 'vitest';
import type { GitWorktreeRemovePayload } from '../payload-types.js';
import { handleGitWorktreeRemove } from './git.js';

const mockRemoveWorktree = vi.fn();
const mockPruneWorktrees = vi.fn();
const mockDeleteBranch = vi.fn();
const mockCreateExecutorClient = vi.fn();
const mockReadFile = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('@agor/core/git', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/git')>('@agor/core/git');
  return {
    ...actual,
    removeWorktree: mockRemoveWorktree,
    pruneWorktrees: mockPruneWorktrees,
    deleteBranch: mockDeleteBranch,
  };
});

vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: mockCreateExecutorClient,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: mockReadFile,
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

describe('handleGitWorktreeRemove', () => {
  it('runs prune after successful worktree remove', async () => {
    mockRemoveWorktree.mockReset();
    mockPruneWorktrees.mockReset();
    mockDeleteBranch.mockReset();
    mockCreateExecutorClient.mockReset();
    mockReadFile.mockReset();
    mockExistsSync.mockReset();

    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('gitdir: /tmp/repo/.git/worktrees/feature-x\n');
    mockRemoveWorktree.mockResolvedValue(undefined);
    mockPruneWorktrees.mockResolvedValue(undefined);
    mockDeleteBranch.mockResolvedValue(true);

    const client = {
      io: { disconnect: vi.fn() },
      service: vi.fn(() => ({
        remove: vi.fn(),
      })),
    };
    mockCreateExecutorClient.mockResolvedValue(client);

    const payload: GitWorktreeRemovePayload = {
      command: 'git.worktree.remove',
      sessionToken: 'jwt-token',
      params: {
        worktreeId: '550e8400-e29b-41d4-a716-446655440001',
        worktreePath: '/tmp/worktrees/feature-x',
        deleteDbRecord: false,
        deleteBranch: true,
        branch: 'feature-x',
      },
    };

    const result = await handleGitWorktreeRemove(payload, { dryRun: false });

    expect(result.success).toBe(true);
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/repo', 'feature-x');
    expect(mockPruneWorktrees).toHaveBeenCalledWith('/tmp/repo');
    expect(mockDeleteBranch).toHaveBeenCalledWith('/tmp/repo', 'feature-x');
    expect(mockPruneWorktrees.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockRemoveWorktree.mock.invocationCallOrder[0]
    );
  });
});
