// The work a browser holds for a person who has not signed in.
//
// This module is deliberately free of browser globals so the same shapes can
// be read by the page, by the tests and by the type checker for the server.
// See Data.StoredWork and Naming.Projects for what each field means.

/** A domain check answer. An unknown answer is kept, never dropped. */
export type DomainStatus = 'available' | 'taken' | 'unknown' | 'not_valid'

/** Where a ticked check is in its short life. */
export type PendingCheckStatus = 'pending' | 'running' | 'done' | 'stopped' | 'failed'

/**
 * The six style fields of Generation.styleFields. Every field may be empty.
 * A preferred ending guides suggestions; it never ticks or checks anything.
 */
export interface StyleChoices {
  /** One pick from the naming style list, such as descriptive or invented. */
  namingStyle: string
  /** One pick from the tone list, such as playful or serious. */
  tone: string
  /** One pick from the length list, such as one-word or two-words. */
  length: string
  /** Free words or sounds the names should include. */
  include: string
  /** Free words, sounds or competitor names the names should avoid. */
  avoid: string
  /** Endings the person prefers, kept as bare lower-case labels. */
  preferredEndings: string[]
}

/** One ending the model suggested for a candidate, with its one-line reason. */
export interface CandidateEnding {
  ending: string
  reason: string
}

/** One name in a project, with the reason and style tag that produced it. */
export interface Candidate {
  id: string
  name: string
  reason: string
  styleTag: string
  /** Up to five unranked endings, each with a reason. */
  suggestedEndings: CandidateEnding[]
  roundNumber: number
  createdAt: number
}

/** One answer for one name and ending pair. Older answers stay as history. */
export interface DomainResult {
  id: string
  candidateId: string | null
  name: string
  ending: string
  status: DomainStatus
  reason: string
  checkedAt: number
}

/** A ticked name and ending pair, including one that has not run yet. */
export interface PendingCheck {
  id: string
  candidateId: string | null
  name: string
  ending: string
  status: PendingCheckStatus
  requestedAt: number
}

/** A name the person rejected. It is never suggested again in this project. */
export interface RejectedName {
  name: string
  rejectedAt: number
}

/** A note the person wrote on a name. More than one note per name is allowed. */
export interface Note {
  id: string
  name: string
  body: string
  createdAt: number
  updatedAt: number
}

/** The usage spent on one project. */
export interface ProjectUsage {
  rounds: number
  revisions: number
  checks: number
  credits: number
  updatedAt: number
}

/** One project, complete with everything the specification stores for it. */
export interface Project {
  id: string
  name: string
  description: string
  industry: string
  style: StyleChoices
  candidates: Candidate[]
  rejectedNames: RejectedName[]
  notes: Note[]
  domainResults: DomainResult[]
  pendingChecks: PendingCheck[]
  usage: ProjectUsage
  createdAt: number
  updatedAt: number
}

/** The identity of one browser that has not signed in. */
export interface AnonymousIdentity {
  id: string
  createdAt: number
  /**
   * The day of the month on which the monthly allowance refreshes, taken
   * from the first visit. It is between 1 and 31.
   */
  allowanceAnchorDay: number
  /** The free-use counters for the current allowance period. */
  usage: AnonymousUsage
}

/** The counters kept against an anonymous identity for one period. */
export interface AnonymousUsage {
  /** The month the period started in, written as YYYY-MM. */
  period: string
  rounds: number
  revisions: number
  checks: number
  updatedAt: number
}

/** The shape of a project when it is read without its full lists. */
export interface ProjectSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  candidateCount: number
  rejectedNameCount: number
  noteCount: number
  domainResultCount: number
  pendingCheckCount: number
  usage: ProjectUsage
}

/** A change to the inputs of a project. The name changes through rename. */
export interface ProjectPatch {
  description?: string
  industry?: string
  style?: Partial<StyleChoices>
}

/** A counted amount to add to a project and to the browser identity. */
export interface UsageDelta {
  rounds?: number
  revisions?: number
  checks?: number
  credits?: number
}

/** A candidate to add to a project. Its id and time are made by the store. */
export interface NewCandidate {
  name: string
  reason?: string
  styleTag?: string
  suggestedEndings?: CandidateEnding[]
  roundNumber?: number
}

/** A note to add to a project. Its id and time are made by the store. */
export interface NewNote {
  name: string
  body: string
}

/** A domain result to add to a project. Its id is made by the store. */
export interface NewDomainResult {
  candidateId?: string | null
  name: string
  ending: string
  status: DomainStatus
  reason?: string
  checkedAt?: number
}

/** A pending check to add to a project. Its id is made by the store. */
export interface NewPendingCheck {
  candidateId?: string | null
  name: string
  ending: string
  requestedAt?: number
}

/** The minimum storage surface used by the store, matching Web Storage. */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
