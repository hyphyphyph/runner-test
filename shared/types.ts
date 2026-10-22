// Shapes shared by the server and the browser.

export type DomainStatus = 'unchecked' | 'available' | 'taken' | 'unknown' | 'not valid'

export type CandidateStatus = 'candidate' | 'kept' | 'rejected' | 'dropped'

export type Level = 'quick' | 'balanced' | 'thorough'

export const LEVELS: Level[] = ['quick', 'balanced', 'thorough']

export interface Style {
  namingStyle: string
  tone: string
  length: '' | 'one' | 'two'
  include: string
  avoid: string
}

export const EMPTY_STYLE: Style = { namingStyle: '', tone: '', length: '', include: '', avoid: '' }

export interface Candidate {
  id: string
  projectId: string
  name: string
  reason: string
  style: string
  domain: string | null
  domainStatus: DomainStatus
  domainReason: string | null
  checkedAt: number | null
  status: CandidateStatus
  round: number
  addedBy: string | null
  changedBy: string | null
  createdAt: number
}

export interface Note {
  id: string
  projectId: string
  candidateId: string | null
  body: string
  author: string | null
  version: number
  conflictOf: string | null
  updatedAt: number
}

export interface Project {
  id: string
  name: string
  description: string
  industry: string
  style: Style
  shared: boolean
  orgId: string | null
  ownerLabel: string | null
  rounds: number
  usage: { rounds: number; revisions: number; checks: number; credits: number }
  conflictWith: string | null
  offeredFrom: string | null
  createdAt: number
  updatedAt: number
}

export interface ProjectDetail extends Project {
  candidates: Candidate[]
  notes: Note[]
  canShare: boolean
}

export interface LevelInfo {
  level: Level
  label: string
  multiplier: number
  creditCost: number
  batch: number
  expectedSeconds: number
  available: boolean
  unavailableReason: string | null
}

export interface Allowance {
  subject: 'device' | 'account' | 'organization'
  plan: 'free' | 'pro' | 'studio'
  rounds: { used: number; limit: number }
  revisions: { used: number; limit: number }
  checks: { used: number; limit: number }
  credits: number
  resetsAt: number
}

export interface Me {
  device: string
  account: null | {
    id: string
    email: string
    plan: 'free' | 'pro' | 'studio'
    planActive: boolean
    credits: number
    operator: boolean
    hasPassword: boolean
    emailPrefs: Record<string, boolean>
    org: null | { id: string; name: string; role: 'owner' | 'member'; seats: number }
  }
  allowance: Allowance
  levels: LevelInfo[]
  styleLists: { namingStyle: string[]; tone: string[] }
  freshnessMinutes: number
}

export interface Gate {
  gate: true
  ranOut: string
  resetsAt: number | null
  signedIn: boolean
  canBuyCredits: boolean
  network?: boolean
}

export interface Problem {
  error: string
  retry?: boolean
}
