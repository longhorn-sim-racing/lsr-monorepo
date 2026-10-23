import { beforeEach, describe, expect, it, vi } from 'vitest';

const guards = vi.hoisted(() => ({ requireUser: vi.fn() }));
const discord = vi.hoisted(() => ({ unlinkDiscord: vi.fn() }));
const nav = vi.hoisted(() => ({ redirect: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const db = vi.hoisted(() => {
  const db = {
    user: { delete: vi.fn() },
    jackMessage: { updateMany: vi.fn() },
    notification: { findMany: vi.fn() },
    applicationEmail: { findMany: vi.fn() },
    emailEvent: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return db;
});
vi.mock('@/server/auth/guards', () => guards);
vi.mock('@/server/services/discord-link.service', () => discord);
vi.mock('next/navigation', () => nav);
vi.mock('next/cache', () => cache);
vi.mock('@/server/db', () => ({ prisma: db }));

import { deleteAccount } from './actions';

const order: string[] = [];

beforeEach(() => {
  order.length = 0;
  guards.requireUser.mockResolvedValue({ id: 'user-1', handle: 'avery-lane', email: ' Avery.Lane@Example.test ' });
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  db.notification.findMany.mockResolvedValue([{ emailMessageId: 'resend-n1' }, { emailMessageId: 'resend-n2' }]);
  db.applicationEmail.findMany.mockResolvedValue([{ resendMessageId: 'resend-a1' }]);
  db.emailEvent.deleteMany.mockImplementation(async () => (order.push('email events'), { count: 3 }));
  db.user.delete.mockImplementation(async () => order.push('user'));
});

describe('deleteAccount', () => {
  it("deletes the delivery events of mail to them, by their address and by the club's emails to them, before the account goes", async () => {
    await deleteAccount();
    // Stored lowercased by the webhook
    expect(db.emailEvent.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ recipient: 'avery.lane@example.test' }, { resendId: { in: ['resend-n1', 'resend-n2', 'resend-a1'] } }] },
    });
    // Read before the account (and with it those rows) is deleted
    expect(db.notification.findMany).toHaveBeenCalledWith({ where: { userId: 'user-1', emailMessageId: { not: null } }, select: { emailMessageId: true } });
    expect(db.applicationEmail.findMany).toHaveBeenCalledWith({
      where: { application: { userId: 'user-1' }, resendMessageId: { not: null } },
      select: { resendMessageId: true },
    });
    expect(order).toEqual(['email events', 'user']);
    expect(db.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(nav.redirect).toHaveBeenCalledWith('/?account=deleted');
  });

  it('goes by address alone when the club never emailed them', async () => {
    db.notification.findMany.mockResolvedValue([]);
    db.applicationEmail.findMany.mockResolvedValue([]);
    await deleteAccount();
    expect(db.emailEvent.deleteMany).toHaveBeenCalledWith({ where: { OR: [{ recipient: 'avery.lane@example.test' }] } });
  });

  it('clears the Discord link first, then the author labels, the delivery events and the account in one transaction', async () => {
    let inTransaction = false;
    discord.unlinkDiscord.mockImplementation(async () => order.push(`unlink${inTransaction ? ' (in)' : ''}`));
    db.jackMessage.updateMany.mockImplementation(async () => order.push(`labels${inTransaction ? ' (in)' : ''}`));
    db.emailEvent.deleteMany.mockImplementation(async () => order.push(`email events${inTransaction ? ' (in)' : ''}`));
    db.user.delete.mockImplementation(async () => order.push(`user${inTransaction ? ' (in)' : ''}`));
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await fn(db);
      } finally {
        inTransaction = false;
      }
    });
    await deleteAccount();
    expect(order).toEqual(['unlink', 'labels (in)', 'email events (in)', 'user (in)']);
    expect(db.jackMessage.updateMany).toHaveBeenCalledWith({ where: { authorUserId: 'user-1' }, data: { authorLabel: null } });
  });
});
