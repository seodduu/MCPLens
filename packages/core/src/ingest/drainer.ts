import {
  claimPending,
  markProcessed,
  releaseClaim,
  type ClaimedEnvelope,
  type ClaimBatch,
  type InboxOptions,
} from './inbox.js';

export class InboxDrainer {
  constructor(private readonly inbox: InboxOptions = {}) {}

  claim(): ClaimBatch {
    return claimPending(this.inbox);
  }

  complete(claim: ClaimedEnvelope): void {
    markProcessed(claim, this.inbox);
  }

  release(claim: ClaimedEnvelope): void {
    releaseClaim(claim, this.inbox);
  }
}
