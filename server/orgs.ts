// Studio organizations (Organization, Membership, SharedProjects). One owner
// pays for at least three seats and adds and removes members.

import type { Ctx } from './context.ts'
import { all, id, one, run, token, tx } from './db.ts'
import type { AccountRow, Actor, OrgRow } from './allowance.ts'
import { allowance } from './allowance.ts'
import { normalEmail, requireAccount, sha256 } from './auth.ts'
import { MIN_SEATS, cancelSubscription, changeSeats } from './billing.ts'
import { fail } from './http.ts'

export function createOrg(ctx: Ctx, owner: AccountRow, name: string, seats: number, subscription: string | null): string {
  const oid = id('o_')
  run(
    ctx.db,
    'insert into orgs (id, name, owner_id, seats, plan_active, stripe_subscription, anchor_day, created_at) values (?, ?, ?, ?, 1, ?, ?, ?)',
    oid,
    name,
    owner.id,
    Math.max(MIN_SEATS, seats),
    subscription,
    owner.anchor_day,
    Date.now(),
  )
  run(ctx.db, "insert into org_members (org_id, account_id, role, joined_at) values (?, ?, 'owner', ?)", oid, owner.id, Date.now())
  // The owner's own projects join the organization, still private.
  run(ctx.db, 'update projects set org_id = ? where account_id = ?', oid, owner.id)
  return oid
}

export function requireOwner(actor: Actor): OrgRow & { role: 'owner' | 'member' } {
  requireAccount(actor)
  if (!actor.org) fail(400, 'You are not in a Studio organization.')
  if (actor.org.role !== 'owner') fail(403, 'Only the owner of the organization can do this.')
  return actor.org
}

function memberCount(ctx: Ctx, orgId: string): number {
  return (ctx.db.prepare('select count(*) as n from org_members where org_id = ?').get(orgId) as { n: number }).n
}

export function orgView(ctx: Ctx, actor: Actor) {
  requireAccount(actor)
  const org = actor.org
  if (!org) return null
  const members = all<{ id: string; email: string; role: string; joined_at: number }>(
    ctx.db,
    'select a.id, a.email, m.role, m.joined_at from org_members m join accounts a on a.id = m.account_id where m.org_id = ? order by m.joined_at',
    org.id,
  )
  const invites =
    org.role === 'owner'
      ? all(ctx.db, 'select id, email, created_at from invites where org_id = ? and accepted_at is null and revoked = 0 order by created_at', org.id)
      : []
  return {
    id: org.id,
    name: org.name,
    role: org.role,
    seats: org.seats,
    active: org.plan_active === 1,
    credits: org.credits,
    members,
    invites,
    usage: org.role === 'owner' ? allowance(ctx.db, ctx.settings, actor) : null,
  }
}

export function invite(ctx: Ctx, actor: Actor, emailRaw: string): void {
  const org = requireOwner(actor)
  const email = normalEmail(emailRaw)
  const member = one(
    ctx.db,
    'select 1 from org_members m join accounts a on a.id = m.account_id where m.org_id = ? and a.email = ?',
    org.id,
    email,
  )
  if (member) fail(400, 'That person is already a member.')
  const t = token()
  tx(ctx.db, () => {
    run(ctx.db, 'update invites set revoked = 1 where org_id = ? and email = ? and accepted_at is null', org.id, email)
    run(
      ctx.db,
      'insert into invites (id, org_id, email, token_hash, created_at) values (?, ?, ?, ?, ?)',
      id('i_'),
      org.id,
      email,
      sha256(t),
      Date.now(),
    )
  })
  ctx.mail.queue(email, 'invite', `Join ${org.name} on NameTempest`, [
    `${actor.account!.email} invited you to join the studio "${org.name}".`,
    `Accept the invitation here: ${ctx.baseUrl}/#/invite/${t}`,
    'You can sign in with a password or with a sign-in link sent by email.',
  ])
}

export function revokeInvite(ctx: Ctx, actor: Actor, inviteId: string): void {
  const org = requireOwner(actor)
  run(ctx.db, 'update invites set revoked = 1 where id = ? and org_id = ?', inviteId, org.id)
}

export function inviteInfo(ctx: Ctx, t: string) {
  const inv = one<{ id: string; org_id: string; email: string; accepted_at: number | null; revoked: number }>(
    ctx.db,
    'select * from invites where token_hash = ?',
    sha256(t),
  )
  if (!inv || inv.revoked) fail(404, 'This invitation is no longer valid. Ask the studio owner to send a new one.')
  if (inv.accepted_at) fail(400, 'This invitation has already been accepted.')
  const org = one<OrgRow>(ctx.db, 'select * from orgs where id = ?', inv.org_id)
  if (!org) fail(404, 'This studio no longer exists.')
  return { inv, org }
}

export function acceptInvite(ctx: Ctx, actor: Actor, t: string): void {
  const a = requireAccount(actor)
  const { inv, org } = inviteInfo(ctx, t)
  if (a.email !== inv.email) fail(403, `This invitation was sent to ${inv.email}. Sign in with that address to accept it.`)
  if (actor.org) fail(400, 'You are already in a Studio organization. Leave it before joining another.')
  if (memberCount(ctx, org.id) >= org.seats) fail(409, 'This studio has no free seat. Ask the owner to add a seat, then accept again.')
  tx(ctx.db, () => {
    run(ctx.db, "insert into org_members (org_id, account_id, role, joined_at) values (?, ?, 'member', ?)", org.id, a.id, Date.now())
    run(ctx.db, 'update invites set accepted_at = ? where id = ?', Date.now(), inv.id)
    run(ctx.db, 'update projects set org_id = ? where account_id = ?', org.id, a.id)
  })
  const owner = one<AccountRow>(ctx.db, 'select * from accounts where id = ?', org.owner_id)
  if (owner) ctx.mail.queue(owner.email, 'membership', 'A member joined your studio', [`${a.email} joined "${org.name}".`])
}

// A member leaves, or is removed. Their access to shared projects ends at
// once. Their private projects are offered to the owner, never deleted
// without a message.
export function detachMember(ctx: Ctx, org: OrgRow, member: AccountRow, why: 'left' | 'removed'): void {
  if (member.id === org.owner_id) fail(400, 'The owner cannot leave. Hand the organization to another member first.')
  const shared = all<{ id: string }>(ctx.db, 'select id from projects where org_id = ? and shared = 1 and account_id != ?', org.id, member.id)
  let offered = 0
  tx(ctx.db, () => {
    run(ctx.db, 'delete from org_members where org_id = ? and account_id = ?', org.id, member.id)
    offered = run(
      ctx.db,
      'update projects set account_id = ?, offered_from = ?, shared = 0 where account_id = ? and org_id = ?',
      org.owner_id,
      member.email,
      member.id,
      org.id,
    )
  })
  for (const p of shared) ctx.live.publish(p.id, { type: 'refresh' })
  const owner = one<AccountRow>(ctx.db, 'select * from accounts where id = ?', org.owner_id)
  if (owner) {
    ctx.mail.queue(owner.email, 'membership', why === 'left' ? 'A member left your studio' : 'A member was removed from your studio', [
      `${member.email} ${why === 'left' ? 'left' : 'was removed from'} "${org.name}". Their seat is free.`,
      offered
        ? `${offered} of their projects are now offered to you in your project list. Keep or delete each one.`
        : 'They had no projects in the organization.',
    ])
  }
  ctx.mail.queue(member.email, 'membership', `You are no longer in ${org.name}`, [
    why === 'left' ? `You left "${org.name}".` : `You were removed from "${org.name}".`,
    'Your personal account stays, and you can keep naming on the free allowance or a plan of your own.',
  ])
}

export function removeMember(ctx: Ctx, actor: Actor, memberId: string): void {
  const org = requireOwner(actor)
  const member = one<AccountRow>(
    ctx.db,
    'select a.* from accounts a join org_members m on m.account_id = a.id where m.org_id = ? and a.id = ?',
    org.id,
    memberId,
  )
  if (!member) fail(404, 'That person is not a member.')
  detachMember(ctx, org, member, 'removed')
}

export function leave(ctx: Ctx, actor: Actor): void {
  const a = requireAccount(actor)
  if (!actor.org) fail(400, 'You are not in an organization.')
  detachMember(ctx, actor.org, a, 'left')
}

export function transferOwnership(ctx: Ctx, actor: Actor, memberId: string): void {
  const org = requireOwner(actor)
  const member = one(ctx.db, 'select 1 from org_members where org_id = ? and account_id = ?', org.id, memberId)
  if (!member || memberId === org.owner_id) fail(400, 'Choose another member of the organization.')
  tx(ctx.db, () => {
    run(ctx.db, "update org_members set role = 'member' where org_id = ? and account_id = ?", org.id, org.owner_id)
    run(ctx.db, "update org_members set role = 'owner' where org_id = ? and account_id = ?", org.id, memberId)
    run(ctx.db, 'update orgs set owner_id = ? where id = ?', memberId, org.id)
  })
}

export async function setSeats(ctx: Ctx, actor: Actor, seats: number): Promise<void> {
  const org = requireOwner(actor)
  if (!Number.isInteger(seats) || seats < MIN_SEATS) fail(400, `A studio needs at least ${MIN_SEATS} seats.`)
  if (seats < memberCount(ctx, org.id)) fail(400, 'You cannot have fewer seats than members. Remove a member first.')
  await changeSeats(ctx, org, seats)
}

// Closing an organization never deletes its members' personal accounts.
// Projects return to the member who made them, unshared.
export async function closeOrg(ctx: Ctx, actor: Actor): Promise<void> {
  const org = requireOwner(actor)
  await cancelSubscription(ctx, org.stripe_subscription)
  const members = all<AccountRow>(ctx.db, 'select a.* from accounts a join org_members m on m.account_id = a.id where m.org_id = ?', org.id)
  tx(ctx.db, () => {
    run(ctx.db, 'update projects set org_id = null, shared = 0 where org_id = ?', org.id)
    run(ctx.db, 'delete from org_members where org_id = ?', org.id)
    run(ctx.db, 'update invites set revoked = 1 where org_id = ?', org.id)
    // Credits bought for the studio stay with the owner.
    run(ctx.db, 'update accounts set credits = credits + ? where id = ?', org.credits, org.owner_id)
    run(ctx.db, 'delete from orgs where id = ?', org.id)
  })
  for (const m of members) {
    if (m.id === org.owner_id) continue
    ctx.mail.queue(m.email, 'membership', `${org.name} was closed`, [
      `The studio "${org.name}" was closed by its owner. Your personal account and the projects you made stay with you.`,
    ])
  }
}
