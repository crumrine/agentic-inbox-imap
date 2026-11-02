# Bounded HTML scoring (DEV-962)

The Inbox adapter uses Workers' native `HTMLRewriter` to extract inert text and
HTTP anchors before its private scoring RPC. The portable scorer still does not
parse raw HTML. No package dependency or version changed.

Limits are checked before parsing/allocation where possible: 65,536 UTF-8 source
bytes (and UTF-16 length), 1,024 start tags, nesting depth 32, 16,384 extracted
text bytes, 50 HTTP anchors, 2,048 bytes per anchor field, and 16,384 total href
bytes. A callback limit aborts native parsing. Native response consumption
propagates errors and cancels parsing; its discarded output cannot exceed the
bounded source. Failed/over-limit HTML produces an unavailable assessment and
preserves Inbox delivery. No partial prefix is routed as a completed inspection.

No rendering, JavaScript/CSS execution, external images, forms, URL navigation,
DNS, attachment inspection, AI or outbound mail occurs. Active containers,
blockquotes, common quoted containers and explicitly hidden elements are omitted.
This is lexical extraction, not browser visibility analysis: external CSS is not
loaded, image text is not OCR'd, and malformed/implicitly closed markup can
conservatively exhaust the depth limit. Fixed numeric/common entities are decoded
once; this is not a complete named-entity dictionary. Unknown remains distinct
from safe. Existing MIME parsing precedes this bounded extraction and is not
made safe for arbitrary hostile MIME by this change.

The pinned scorer source is `967ab7383931b27be545a5748643a8f0a29156d0`
([Mail Scoring PR 5](https://github.com/crumrine/mail-scoring/pull/5)).
The joined workerd check uses its pinned runtime as well as its source.
It also checks that absent optional Reply-To/envelope fields do not masquerade
as malformed identity evidence.

The existing RPC schema/engine are retained. The decoder accepts stored
`rules-1` and new `rules-2`; the new combined rule is valid only in `rules-2`.
New assessments record policy `inbox-html-2`; old assessments remain unchanged.
Automatic routing still requires successful scoring, no disallowed inspection
limits, score >=45 and either the existing combined sensitive/identity evidence
or the new 45-point `brand_impersonation_combined` evidence. Allow/block
preferences, recoverable Spam, manual rescue and raw MIME/UID handling remain.
Reads do not rescore, and this release does not backfill historical messages.

Brand coverage initially includes QuickBooks/Intuit and PayPal. The rule combines
an explicit recognized sender display identity, an unrelated sender domain,
account/review/security lure language, and an unrelated HTTP action destination.
Brand mentions, normal marketing and tracking links alone do not qualify. One
explicit HTTP redirect parameter can be inspected lexically without requesting
it; ambiguous or nested redirects add an inspection limit and prevent automatic
routing. This parameter is a claimed destination, not proof of a server redirect.

Rollout order: publish the caller that accepts both rule versions, then publish
the private scorer at `rules-2`. In a rollback, `MAIL_SCORING_MODE=shadow` preserves
mail and stops new automatic routing. Preserve the live Access, service,
storage, agent and email bindings and disabled public scorer/preview settings.

All committed fixtures are original synthetic examples using reserved domains.
The private message that motivated this work is not a redistributed fixture.
Workerd tests check actual native parsing, active/network negative controls,
byte/tag/depth/output/link ceilings, malformed inputs, delivery preservation,
new-rule persistence and routing. Core tests separately check classification,
negative controls, finite output and protocol versions. These tests do not
establish production classification accuracy or hosted CPU/cost.

Primary references:

- [Workers HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)
- [Intuit phishing/domain guidance](https://quickbooks.intuit.com/learn-support/en-us/help-article/fraud/identify-suspicious-activity-phishing-scams-fraud/L2NzZQnZu_US_en_US)
- [PayPal phishing guidance](https://securepayments.paypal.com/us/cshelp/article/how-do-i-spot-a-fake-fraudulent-or-phishing-paypal-email-or-website-help164)
