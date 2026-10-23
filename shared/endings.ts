// The offered endings, built from public registry sources.
//
// DomainCheck.offeredEndings says an ending may be suggested or ticked only
// when it appears in the refreshed root zone list, the shipped lookup chain
// has a route that answers both free and taken for it, and its registry's
// terms allow a hosted product to query it. This module holds the shape every
// part reads, so the server, the API and the browser agree on what an offered
// ending is.
//
// The list itself is never typed in by hand. `server/offered-endings.ts`
// refreshes it from the IANA root zone list and the RDAP bootstrap file.

/** Why an ending is not offered. */
export type OfferedEndingReasonCode =
  /** The refreshed root zone list no longer contains it. */
  | 'not_in_root_zone'
  /** The shipped chain has no route that can settle both free and taken. */
  | 'route_cannot_settle'
  /** The registry's terms do not allow a hosted product to query it. */
  | 'terms_disallow'

/** One ending the refresh has seen, with the facts behind its offer. */
export interface OfferedEnding {
  /** Bare lower-case ending, such as `com`. */
  ending: string
  /** It appears in the refreshed root zone list. */
  inRootZone: boolean
  /** The shipped chain has a route that can answer both free and taken. */
  routeAnswersBoth: boolean
  /** The registry's terms allow a hosted product to query it at this volume. */
  termsAllowHostedQueries: boolean
  /**
   * The specification names this ending, so it has one seeded row before the
   * first refresh. It is true only for .com. Once the sources have been read,
   * .com is judged by the same three facts as every other ending.
   */
  requiredByProduct: boolean
  /** All three conditions hold. */
  offered: boolean
  /** The first condition that failed, or null when the ending is offered. */
  reasonCode: OfferedEndingReasonCode | null
  /** Plain words for the admin interface, or null when offered. */
  reason: string | null
  /** The registry registration query the bootstrap file gave, when any. */
  registrationQueryUrl: string | null
  /** Where the row last came from, such as `refresh` or `required`. */
  source: string
  /** When the facts were last refreshed, in milliseconds since the epoch. */
  updatedAt: number
}

/** The one read every other part uses to learn what may be offered. */
export interface OfferedEndingsReport {
  /** Every ending the refresh has seen, ordered by ending. */
  endings: OfferedEnding[]
  /** The endings that may be suggested or ticked, in the same order. */
  offeredEndings: string[]
  /** Time of the last successful refresh, or null before the first one. */
  refreshedAt: number | null
}

/**
 * The endings the product promises to offer even before the first successful
 * refresh. The specification names .com as checked in the first version.
 * This is the only ending the code names; every other ending comes from the
 * refreshed sources.
 */
export const REQUIRED_OFFERED_ENDINGS: readonly string[] = Object.freeze(['com'])

/** A bare lower-case ending, with no leading dot. */
const ENDING = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** True when a value is a bare lower-case ending. */
export function isEnding(value: string): boolean {
  return ENDING.test(value)
}
