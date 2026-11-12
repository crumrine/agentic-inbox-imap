// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
export const BALANCED_LEGITIMATE_CONTROLS = [
  {
    "id": "dev-1018_dev1018-ham-01-pharmacy-refill",
    "label": "ham",
    "subject": "Prescription ready for pickup: Atorvastatin 20mg",
    "text": "Hello Elena,\n\nYour refill for Atorvastatin 20mg tablets (Rx #4481920) is ready at Cedar Street Community Pharmacy. Counter pickup hours are 8:30 AM to 6:30 PM Monday through Friday, and 9:00 AM to 2:00 PM on Saturday.\n\nYour copay on file is $10.00. Please bring photo identification if picking up in person, or call (503) 555-0148 if you need to transfer this prescription to another clinic pharmacy.\n\nThank you,\nCedar Street Pharmacy Care Team",
    "stratum": "dev-1018"
  },
  {
    "id": "dev-1018_dev1018-ham-02-clinical-lab-results",
    "label": "ham",
    "subject": "Lab summary posted from your October 30 visit",
    "text": "Hi Marcus,\n\nDr. Patel reviewed the routine metabolic panel and lipid profile drawn during your annual physical on October 30. All values are within the normal reference range, and your fasting glucose improved compared with last autumn.\n\nNo medication changes are recommended right now. Continue your current vitamin D supplement through the winter months and schedule your next routine checkup for next October.\n\nWarm regards,\nNorthside Internal Medicine Nursing Desk",
    "stratum": "dev-1018"
  },
  {
    "id": "dev-1018_dev1018-ham-03-financial-utility-receipt",
    "label": "ham",
    "subject": "Payment confirmation for municipal water account #8830-41",
    "text": "Dear Customer,\n\nWe received your scheduled bank draft of $64.28 on November 8, 2026 for service address 412 Maple Ridge Ave.\n\nBilling period: September 28, 2026 - October 29, 2026\nMeter reading: 1,412 CCF (6 CCF used)\nRemaining balance: $0.00\n\nYour next meter reading is scheduled for November 30, 2026. Keep this message for your household utility records.\n\nCity Water & Sewer Billing Office",
    "stratum": "dev-1018"
  },
  {
    "id": "dev-1018_dev1018-ham-04-financial-bookstore-receipt",
    "label": "ham",
    "subject": "Receipt #INV-2026-9914 from Elliott Bay Technical Books",
    "text": "Thanks for shopping with Elliott Bay Technical Books.\n\nOrder date: November 7, 2026\n1x Designing Data-Intensive Applications (Paperback) - $42.00\n1x Cedar Notebook Dotted Grid A5 - $14.50\nSubtotal: $56.50\nSales tax (10.25%): $5.79\nTotal charged to Visa ending in 7721: $62.29\n\nIn-store pickup is held at the front register under your last name for seven days.",
    "stratum": "dev-1018"
  },
  {
    "id": "dev-1018_dev1018-ham-05-newsletter-civic-library",
    "label": "ham",
    "subject": "November Library Notes: winter reading hours and book repair workshop",
    "text": "Welcome to the November edition of the County Library branch bulletin.\n\nStarting November 15, the Central and Westside branches will stay open until 8:00 PM on Tuesdays and Thursdays to accommodate evening study groups.\n\nOn Saturday, November 21 at 1:30 PM, conservation technician Claire Wu will host a hands-on workshop in Meeting Room B covering cloth spine repair and archival paper hinges. Attendance is free and all materials are provided on site.\n\nSee you at the stacks,\nFriends of the County Library",
    "stratum": "dev-1018"
  },
  {
    "id": "dev-1018_dev1018-ham-06-newsletter-botanical-society",
    "label": "ham",
    "subject": "Pacific Northwest Native Plant Society - late autumn field notes",
    "text": "Hello members,\n\nOur October seed exchange cataloged 74 regional species collected from permitted restoration plots in Skagit and Whatcom counties. Volunteers packaged over four hundred envelopes of Douglas iris, red flowering currant, and nodding onion for school gardens.\n\nNext month's lecture will examine winter twig identification for deciduous shrubs along riparian corridors. Bring a 10x hand lens if you have one.\n\nBest wishes,\nPNW Native Plant Field Committee",
    "stratum": "dev-1018"
  },
  {
    "id": "dev-1018_dev1018-ham-07-engineering-ci-maintenance",
    "label": "ham",
    "subject": "[infra] Planned runner kernel upgrade on build-arm64-03 this Sunday",
    "text": "Team,\n\nWe will drain and reboot build-arm64-03 between 06:00 and 06:45 UTC on Sunday, November 15 to apply the Linux 6.12 LTS point release and update the local Nix store cache.\n\nQueued jobs on arm64 will route to build-arm64-01 and build-arm64-02 automatically during the window. If you have pinned integration suites to host-specific scratch volumes, please migrate those fixtures to the shared artifact bucket before Friday afternoon.\n\n-- Platform Reliability",
    "stratum": "dev-1018"
  },
  {
    "id": "dev-1018_dev1018-ham-08-security-ssh-ca-rotation",
    "label": "ham",
    "subject": "Reminder: bastion host SSH certificate authority rotation on Nov 18",
    "text": "Hi everyone,\n\nThe secondary SSH host CA key deployed to staging and production bastions last month becomes the primary signing key on Wednesday, November 18 at 17:00 PST.\n\nIf your workstation uses the standard known_hosts bundle from the workstation-config repository (commit 8c41a02 or newer), both CA fingerprints are already trusted and no manual action is required. Engineers maintaining custom jump-host configs should verify that @cert-authority *.internal.example.org includes the Ed25519 key ending in +9K2m.\n\nSecurity Engineering",
    "stratum": "dev-1018"
  },
  {
    "id": "dev-1018_dev1018-ham-09-meeting-architecture-sync",
    "label": "ham",
    "subject": "Notes & action items: Storage engine quarterly architecture review",
    "text": "Hi folks,\n\nThanks for joining today's storage architecture sync. Summary of decisions:\n\n1. Keep the WAL segment target at 64 MiB for the upcoming release while we finish benchmarking compaction stalls on NVMe namespaces.\n2. Priya will publish the updated recovery state machine diagram by Wednesday afternoon.\n3. Dan and Tomas will pair on reproducing the snapshotchecksum edge case under simulated torn writes.\n\nOur next sync is Tuesday, November 17 at 10:30 AM PST in Room 4B.\n\nBest,\nHannah",
    "stratum": "dev-1018"
  },
  {
    "id": "dev-1018_dev1018-ham-10-meeting-parent-teacher-schedule",
    "label": "ham",
    "subject": "Updated room assignment for Thursday parent-teacher conferences",
    "text": "Hello families,\n\nBecause the gymnasium floor is being refinished this week, all seventh-grade science and mathematics conferences scheduled for Thursday, November 12 between 4:00 PM and 7:30 PM will take place in the second-floor media center instead of Gym Annex A.\n\nYour fifteen-minute appointment time with Mr. Alvarez remains unchanged. Hallway signs from the east entrance will point toward the stairs and elevator.\n\nSincerely,\nLincoln Middle School Main Office",
    "stratum": "dev-1018"
  },
  {
    "id": "dev-1018_dev1018-ham-11-unicode-combining-colloquium",
    "label": "ham",
    "subject": "Colloque d'automne : édition critique de Zoë Kraüsseldorf & Sören Ångström",
    "text": "Bonjour à toutes et à tous,\n\nLe séminaire de philologie comparée accueillera professeure Zoë Kraüsseldorf (Université de Genève) et Dr Sören Ångström (Uppsala) ce vendredi à 14h00 en salle 214.\n\nNous discuterons la normalisation Unicode des textes médiévaux (formes combinantes é, ä, ô, ç vs précomposées) ainsi que les citations bilingues en grec ancien (λόγος) et japonais (資料館の目録).\n\nUn café sera servi après la séance.\n\nCordialement,\nDépartement des langues et lettres",
    "stratum": "dev-1018"
  },
  {
    "id": "dev-1018_dev1018-ham-12-ascii-hardware-bench-log",
    "label": "ham",
    "subject": "Bench calibration log: Keithley DMM6500 ambient drift check",
    "text": "Hi Lab Group,\n\nCompleted the 24-hour thermal stability check on bench unit DMM6500-B2 using the 10.00000 V Fluke 732B transfer standard.\n\nAmbient temp: 22.4 C +/- 0.3 C\nMean reading: 9.999984 V\nPeak-to-peak drift: 1.8 uV\nLine cycle integration: 10 NPLC, autozero enabled\n\nThe instrument remains well within the 90-day specification window, so we are cleared to start the ADC linearity sweep tomorrow morning.\n\nRegards,\nDevon",
    "stratum": "dev-1018"
  },
  {
    "id": "ctrl-01-finance-statement",
    "label": "ham",
    "subject": "Q3 Brokerage Tax Lot Reconciliation and Dividend Summary",
    "text": "Hi Elena,\n\nAttached is the reconciled Q3 worksheet for the municipal bond ladder and equity dividend reinvestments. Please check row 14 where the October 2 settlement crossed the quarter boundary so we align with the custodian statement before Friday's audit meeting.\n\nBest,\nMarcus"
  },
  {
    "id": "ctrl-02-medical-pharmacy",
    "label": "ham",
    "subject": "Prescription refill ready for pickup at Clinic Pharmacy #04",
    "text": "Hello Samira,\n\nYour maintenance refill for atorvastatin 20mg tablets (Rx #4481920) has been filled by the clinical pharmacist and will be held at the Westside outpatient counter through November 15. Please bring your photo ID if picking up in person, or reply to coordinate courier delivery with Dr. Chen's office.\n\nThank you,\nWestside Health Pharmacy Team"
  },
  {
    "id": "ctrl-03-engineering-incident",
    "label": "ham",
    "subject": "Postmortem notes: replica lag on shard-07 during index rebuild",
    "text": "Team,\n\nDuring Tuesday's maintenance window, write amplification from the concurrent btree compaction pushed WAL replay latency to 4.2s on shard-07. throttling `max_parallel_maintenance_workers` to 2 brought replication lag back under 80ms within four minutes. Action items and flamegraphs are linked in the sprint tracker.\n\n-- Devon"
  },
  {
    "id": "ctrl-04-security-advisory",
    "label": "ham",
    "subject": "Scheduled rotation of internal SSH CA host certificates on 2026-11-12",
    "text": "All infrastructure engineers,\n\nWe are rotating the secondary bastion SSH host signing key this Thursday at 18:00 UTC. Hosts managed by systemd-confd already trust the new public CA fingerprint in /etc/ssh/ssh_known_hosts. If you maintain pinned bastion configs in local dotfiles, pull the latest known_hosts bundle from the internal ops repo.\n\nSecurity Engineering"
  },
  {
    "id": "ctrl-05-transactional-receipt",
    "label": "ham",
    "subject": "Order #INV-2026-8841 shipped via regional ground freight",
    "text": "Hi Jordan,\n\nWe have packed and handed off your order of 4x anodized aluminum DIN mounting rails and M4 captive nut kits. Your shipment reference is FRT-99301842 and delivery is scheduled for Tuesday between 09:00 and 13:00 at the loading dock.\n\nRegards,\nNorthbay Industrial Supply"
  },
  {
    "id": "ctrl-06-mailing-list-kernel",
    "label": "ham",
    "subject": "[PATCH v2 2/3] net: tcp: avoid spurious timer re-arm when rcv_wnd is zero",
    "text": "On Thu, Nov 05, 2026 at 11:14:02AM +0100, Lukas Meier wrote:\n> When the peer advertises a zero window and we already have an active\n> zero-window probe timer queued, tcp_ack() should not reset the backoff\n> counter on duplicate ACK packets.\n\nTested-by: Priya Nair <pnair@example.org>\nAcked-by: Thomas Berg <tberg@example.org>\n\nThe selftest passes across 500 iterations on arm64 and x86_64."
  },
  {
    "id": "ctrl-07-unicode-i18n",
    "label": "ham",
    "subject": "Réunion d'équipe & 議事録の確認 (München / 東京 / São Paulo)",
    "text": "Bonjour à tous,\n\nVoici le résumé de notre synchronisation trimestrielle :\n1. Le déploiement de la mise à jour UTF-8 (normalisation NFC) est terminé sans régression.\n2. 来週の火曜日（11月10日 17:00 JST）にローカリゼーションのレビューを行います。\n3. Bitte prüfen Sie die Übersetzungen für Österreich und die Schweiz bis Donnerstag.\n\nCordialement,\nHélène & 健太"
  },
  {
    "id": "ctrl-08-normal-correspondence",
    "label": "ham",
    "subject": "Dinner plans on Saturday + borrowing the folding ladder",
    "text": "Hey Claire,\n\nAre we still on for Thai food around 6:30pm this Saturday? Also, if you're not using the 8-foot step ladder this weekend, could I borrow it on Sunday morning to clean out the front porch gutters before the rain starts?\n\nSee you soon,\nNate"
  },
  {
    "id": "ctrl-09-finance-payroll",
    "label": "ham",
    "subject": "2027 Open Enrollment confirmation and HSA contribution election",
    "text": "Dear Employee,\n\nThis notice confirms that your benefit elections for the 2027 plan year were recorded on November 8, 2026. Your pre-tax payroll deduction of $150.00 per pay period for the Health Savings Account will take effect on the January 15 pay cycle. No further action is required unless you have a qualifying life event.\n\nHuman Resources Benefits Administration"
  },
  {
    "id": "ctrl-10-medical-appointment",
    "label": "ham",
    "subject": "Lab results posted and follow-up physical therapy schedule",
    "text": "Hi David,\n\nDr. Morales reviewed your comprehensive metabolic panel and lipid profile from Monday morning; all values remain within normal reference ranges. Please arrive 10 minutes early for your shoulder mobility session with physical therapist Anna Kowalski on Wednesday at 2:15 PM.\n\nWarm regards,\nOrthopedic & Sports Medicine Clinic"
  },
  {
    "id": "ctrl-11-engineering-release",
    "label": "ham",
    "subject": "Release candidate v1.14.2-rc1 tagged for staging soak test",
    "text": "Hi folks,\n\nI just tagged v1.14.2-rc1 off the release branch. It contains only the backported parser bounds fix (#412) and the updated timezone database. Staging burn-in will run for 24 hours; please hold off on merging non-blocking dependency bumps until we cut the final tag tomorrow afternoon.\n\nThanks,\nSoren"
  },
  {
    "id": "ctrl-12-mailing-list-bookclub",
    "label": "ham",
    "subject": "[neighborhood-garden] Mulch delivery arrived by the south shed",
    "text": "Hi neighbors,\n\nThe municipal arborist crew dropped off about six cubic yards of wood chips next to the south tool shed this morning. Wheelbarrows and pitchforks are unlocked in bay 2 if anyone wants to top-dress their raised beds before the frost hits this weekend.\n\nHappy gardening,\nMartha (Plot 19)"
  }
] as const;
