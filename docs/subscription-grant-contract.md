# SUB-CONTRACT-01 — Feature grant resolution

Decision: an active, unrevoked feature grant survives subscription cancellation
until its own expiry or revocation. No runtime behavior changes in this ticket.

Evidence, most specific first:

1. FeatureGrant's model contract explicitly overrides the plan while neither
   expired nor revoked; null expiry explicitly means permanent until revoked.
2. SubscriptionPolicy, the Backoffice/member read service and runtime feature
   resolver independently agree: active grant first, stored plan second.
3. Grant creation accepts any existing subscription, including CANCELLED,
   with optional expiry. Cancellation does not revoke grants. Revocation is
   a separate audited operation. The DTO promises permanent-until-revoked.
4. The pre-existing cancelled-subscription test asserts precisely this contract.
   Its August 20, 2026 fixture expired against wall-clock time; the test, not
   the grant resolver, was defective. Its clock is now fixed to August 10.

Precedence:

- Revoked or expired (`expiresAt <= now`) grants are excluded.
- Any remaining grant for the requested feature yields ALLOWED / GRANT.
- Otherwise the stored plan yields ALLOWED or DENIED / PLAN.
- Revocation removes that grant, not the plan entitlement or other active grants.
- No explicit DENY grant or scheduled start is modeled. `grantedAt` is an
  audit timestamp set on creation, not a future validity-window field.
- Missing subscription: runtime fails closed; read API returns not found.

Lifecycle and MVP boundary:

The old schema commentary describing cancellation as an immediate FREE
fallback is inconsistent with executable behavior: changeStatus changes status,
not plan; both resolvers use the stored plan. This ticket does not introduce
a lifecycle-based entitlement cutoff. Trial expiry and grace-period completion
explicitly persist FREE/ACTIVE; expired paid periods first enter grace.
Operators must explicitly downgrade the plan if paid plan access must end on
cancellation, and separately revoke any exceptional grants they intend to end.
In particular, CANCELLED + stored PRO retains plan access until downgraded;
this is existing behavior, not a new grant extension or a billing guarantee.

Core Free features remain available. Time-limited grants cannot survive their
expiry; only deliberately unbounded grants survive until revoked. Cancellation
does not silently ignore a support/promotion grant or change Mobile access.
Backoffice UI wording must not imply cancellation automatically revokes grants
or downgrades a plan. No UI or administration API changes are made here.
