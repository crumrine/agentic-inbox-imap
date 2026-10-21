// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	MAIL_SCORING_MODE?: "off" | "shadow";
	MAIL_SCORER?: import("./lib/mail-scoring/protocol").ScorerBinding;
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
}
