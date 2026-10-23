import { beforeEach, describe, expect, it, vi } from 'vitest';

const guards = vi.hoisted(() => ({ requireUser: vi.fn() }));
const service = vi.hoisted(() => ({ unlinkDiscord: vi.fn() }));
const nav = vi.hoisted(() => ({ redirect: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const db = vi.hoisted(() => ({ user: { delete: vi.fn() } }));
vi.mock('@/server/auth/guards', () => guards);
vi.mock('@/server/services/discord-link.service', () => service);
vi.mock('next/navigation', () => nav);
vi.mock('next/cache', () => cache);
vi.mock('@/server/db', () => ({ prisma: db }));

import { deleteAccount } from '@/app/account/actions';
import { unlinkDiscordAction } from './discord-actions';

beforeEach(() => {
  guards.requireUser.mockResolvedValue({ id: 'user-1', handle: 'avery-lane' });
});

describe('unlinkDiscordAction', () => {
  it("removes the signed-in member's own link and comes back to their editor", async () => {
    await unlinkDiscordAction();
    expect(service.unlinkDiscord).toHaveBeenCalledWith('user-1');
    expect(cache.revalidatePath).toHaveBeenCalledWith('/drivers/avery-lane/edit');
    expect(nav.redirect).toHaveBeenCalledWith('/drivers/avery-lane/edit?discord=unlinked#discord');
  });

  it("does nothing for someone who isn't signed in", async () => {
    guards.requireUser.mockRejectedValue(new Error('You must be logged in to perform this action.'));
    await expect(unlinkDiscordAction()).rejects.toThrow(/logged in/);
    expect(service.unlinkDiscord).not.toHaveBeenCalled();
  });
});

describe('deleteAccount', () => {
  it('clears the Discord link before the account goes', async () => {
    const order: string[] = [];
    service.unlinkDiscord.mockImplementation(async () => order.push('unlink'));
    db.user.delete.mockImplementation(async () => order.push('delete'));
    await deleteAccount();
    expect(order).toEqual(['unlink', 'delete']);
    expect(service.unlinkDiscord).toHaveBeenCalledWith('user-1');
  });
});
