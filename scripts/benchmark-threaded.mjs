// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file.
// Run with Node 24: node scripts/benchmark-threaded.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
const source = readFileSync(
	new URL("../workers/durableObject/index.ts", import.meta.url),
	"utf8",
);
const normalization = source.match(
	/const NORMALIZED_SUBJECT_SQL = `([\s\S]+?)`;/,
)[1];
const section = source.slice(
	source.indexOf("\tasync getThreadedEmails"),
	source.indexOf("// ── Single email operations"),
);
const sql = [...section.matchAll(/`([^`]+)`/g)]
	.map((m) => m[1])
	.filter((s) => s.includes("SELECT"))
	.map((s) => s.replaceAll("${NORMALIZED_SUBJECT_SQL}", normalization));
assert.equal(sql.length, 4);
const baseline = JSON.parse(
	readFileSync(
		new URL("../test/fixtures/threaded-baseline.json", import.meta.url),
	),
);
const output = {
	node: process.version,
	method:
		"in-memory SQLite; 10KB bodies; warmup + 9 alternating pairs; full list and count; setup excluded; milliseconds",
	cases: [],
};
for (const size of [1000, 10000]) {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE folders(id TEXT PRIMARY KEY, name TEXT); INSERT INTO folders VALUES ('inbox','inbox'),('draft','draft'),('sent','sent');
 CREATE TABLE emails(id TEXT PRIMARY KEY, folder_id TEXT, subject TEXT, sender TEXT, recipient TEXT, date TEXT, body TEXT, thread_id TEXT, read INTEGER, starred INTEGER DEFAULT 0, in_reply_to TEXT, email_references TEXT);
 CREATE INDEX idx_emails_folder ON emails(folder_id); CREATE INDEX idx_emails_folder_date ON emails(folder_id,date DESC);
 CREATE INDEX idx_emails_thread ON emails(thread_id); CREATE INDEX idx_emails_reply ON emails(in_reply_to); CREATE INDEX idx_emails_date ON emails(date);`);
	output.sqlite = db
		.prepare("select sqlite_version() as version")
		.get().version;
	const insert = db.prepare(
		"INSERT INTO emails(id,folder_id,subject,sender,recipient,date,body,thread_id,read,in_reply_to) VALUES (?,?,?,?,?,?,?,?,?,?)",
	);
	db.exec("BEGIN");
	for (let i = 0; i < size; i++)
		insert.run(
			`b-${i}`,
			i % 10 === 0 ? "draft" : i % 4 === 0 ? "sent" : "inbox",
			`Topic ${Math.floor(i / 5)}`,
			`s${i % 7}@example.com`,
			"to@example.com",
			new Date(1700000000000 + i * 1000).toISOString(),
			"0123456789".repeat(1000),
			i % 13 === 0 ? null : `t-${Math.floor(i / 5)}`,
			i % 2,
			i % 3 === 0 ? `b-${i - 1}` : null,
		);
	db.exec("COMMIT");
	for (const folder of ["inbox", "draft"])
		for (const page of [1, 10]) {
			const draft = folder === "draft",
				bindings = { 1: folder, 2: 25, 3: (page - 1) * 25 };
			const oldList = db.prepare(draft ? baseline.draft : baseline.inbox),
				oldCount = db.prepare(
					draft ? baseline.draftCount : baseline.inboxCount,
				);
			const newList = db.prepare(sql[draft ? 0 : 1]),
				newCount = db.prepare(sql[draft ? 2 : 3]);
			const run = (list, count) => ({
				emails: list.all(bindings),
				totalCount: count.get({ 1: folder }),
			});
			assert.deepEqual(run(newList, newCount), run(oldList, oldCount));
			const before = [],
				after = [];
			const measure = (list, count) => {
				const start = performance.now();
				run(list, count);
				return performance.now() - start;
			};
			for (let r = 0; r < 10; r++) {
				let a, b;
				if (r % 2) {
					b = measure(newList, newCount);
					a = measure(oldList, oldCount);
				} else {
					a = measure(oldList, oldCount);
					b = measure(newList, newCount);
				}
				if (r) {
					before.push(a);
					after.push(b);
				}
			}
			const stats = (a) => ({
				median: a.toSorted((a, b) => a - b)[4],
				max: Math.max(...a),
				samples: a,
			});
			output.cases.push({
				size,
				folder,
				page,
				before: stats(before),
				after: stats(after),
				baselinePlan: db
					.prepare(
						"EXPLAIN QUERY PLAN " + (draft ? baseline.draft : baseline.inbox),
					)
					.all(bindings)
					.map(({ id, parent, detail }) => `${id}/${parent}: ${detail}`),
				optimizedPlan: db
					.prepare("EXPLAIN QUERY PLAN " + sql[draft ? 0 : 1])
					.all(bindings)
					.map(({ id, parent, detail }) => `${id}/${parent}: ${detail}`),
			});
		}
	db.close();
}
console.log(JSON.stringify(output, null, 2));
