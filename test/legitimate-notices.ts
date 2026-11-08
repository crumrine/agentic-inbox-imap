// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
// Original synthetic regression controls. Never TRAIN rows; the first caught a rejected candidate.
export const LEGITIMATE_NOTICES = [
  {
    "subject": "Medication therapy management & generic formulary update",
    "text": "Dear Patient, our clinical pharmacist reviewed your blood pressure and cholesterol prescription profile. Your tablet refill is ready for pickup at the clinic pharmacy counter. Please review the attached dosing schedule and consult your physician regarding any medication interactions."
  },
  {
    "subject": "Your prescription refill is ready for pickup",
    "text": "Hello, your prescription refill is ready for pickup at the pharmacy counter. Please bring your photo identification and insurance card when you arrive. Ask the pharmacist if you have questions about your dosage."
  },
  {
    "subject": "Pharmacy notification: prescription ready",
    "text": "Your prescription is ready to be picked up at our pharmacy location. Please check our store hours before visiting and speak with the pharmacist if you have any questions regarding your medicine."
  },
  {
    "subject": "Post-operative pain management and antibiotic instructions",
    "text": "Discharge summary: Take one capsule by mouth twice daily with food for seven days. Do not exceed the prescribed dosage. Contact the on-call nurse or surgical resident if you experience fever, nausea, or allergic reaction."
  },
  {
    "subject": "Appointment reminder: annual physical exam",
    "text": "This is a reminder of your upcoming appointment with Dr. Smith at the medical clinic next Tuesday at 10:00 AM. Please arrive 15 minutes early to complete your registration forms."
  },
  {
    "subject": "Security alert: new sign-in to your account",
    "text": "We noticed a new sign-in to your account from a macOS device. If this was you, you can safely ignore this email. If you do not recognize this activity, please reset your password immediately."
  },
  {
    "subject": "Production TLS certificate rotation and SSH bastion maintenance",
    "text": "Infrastructure security notice: We are rotating the internal root authority and updating OpenSSH host keys on Saturday at 02:00 UTC. Engineers should verify fingerprint changes in the internal runbook and report any authentication anomalies to the platform team."
  },
  {
    "subject": "Quarterly 401(k) retirement contribution statement and tax form 1099-R",
    "text": "Your quarterly fiduciary statement and dividend reinvestment summary are available in the employee benefits portal. Please review your beneficiary designations and annual contribution limits before the fourth-quarter payroll deadline."
  },
  {
    "subject": "Équipe d’ingénierie — Compte rendu de la réunion architecture & sécurité",
    "text": "Bonjour à tous, voici le résumé des décisions prises lors de la revue technique. Les tests de charge et la validation du schéma sont terminés sans erreur. Merci de vérifier vos tickets avant vendredi."
  },
  {
    "subject": "보안 공지 및 정기 점검 안내 (Security Maintenance)",
    "text": "안녕하세요. 내일 오전 2시부터 시스템 정기 점검이 진행됩니다. 점검 시간 동안 이메일 알림이 지연될 수 있으니 업무에 참고하시기 바랍니다. 감사합니다."
  },
  {
    "subject": "Clinic care plan",
    "text": "Dear patient, your generic prescription medication is ready. Your refill covers blood pressure, cholesterol and pain management. Our physician reviewed your profile. Please contact the clinical pharmacy with any questions."
  },
  {
    "subject": "Your care team follow-up",
    "text": "Your physician has reviewed your blood pressure log and adjusted the prescribed medication dosage. Continue taking your current tablets until your next appointment. Bring your home monitoring record so we can discuss the treatment plan together."
  },
  {
    "subject": "Pharmacy benefit review",
    "text": "The health plan approved the generic alternative for your cholesterol prescription. No new prescription is required. Your pharmacist can explain the change and answer questions about side effects at your next refill."
  },
  {
    "subject": "Medication review completed",
    "text": "Our clinical pharmacist completed the annual review of your prescription profile. We discussed blood pressure, cholesterol, allergy treatment and possible medication interactions. The care summary is available in your usual patient portal."
  },
  {
    "subject": "Discharge medication list",
    "text": "This message confirms the medication list reviewed during discharge. Take the prescribed antibiotic with food and complete the full course. Call the hospital care team if you develop a rash or have questions about the instructions."
  },
  {
    "subject": "Prescription collection reminder",
    "text": "Your monthly prescription is waiting at the clinic pharmacy. Please collect it during normal opening hours and bring identification. If you no longer need this refill, contact the pharmacy so the medication can be returned to stock."
  },
  {
    "subject": "Insurance formulary notice",
    "text": "The next plan year includes changes to covered prescription medicines. Your current treatment remains covered through the end of the year. Discuss any proposed generic substitution with your prescribing clinician before changing medication."
  },
  {
    "subject": "Lab result follow-up",
    "text": "Your recent blood test results are available for review. Your doctor would like to discuss cholesterol management and schedule a follow-up appointment. Please use the usual clinic telephone number or patient portal to arrange a visit."
  },
  {
    "subject": "Refill request received",
    "text": "We received your request to renew the blood pressure prescription. The physician will review the request within two business days. This confirmation does not change your dosage or treatment schedule."
  },
  {
    "subject": "Patient education session",
    "text": "The community clinic is offering a medication safety session for patients and caregivers. The pharmacist will discuss prescription labels, dosing schedules and common interactions. Please ask the reception team about attendance at your next visit."
  },
  {
    "subject": "Internal team schedule and agenda for the operations planning meeting",
    "text": "Please find your updated account information ready for review."
  },
  {
    "subject": "Outpatient pharmacy notification: prescription renewal ready for collection",
    "text": "Dear Patient, the clinical pharmacist has completed the review of your blood pressure and cholesterol medication profile. Your routine tablet prescription is ready for collection at the outpatient clinic dispensary during regular hours. Please bring your photo identification and current medicine list if you would like to discuss dosing instructions with the care team."
  },
  {
    "subject": "Cardiology clinic follow-up and home blood pressure monitoring plan",
    "text": "Following your consultation with the specialist, we have updated your treatment record and medication schedule. Please continue taking your prescribed tablet dose with breakfast and record your daily blood pressure readings in the monitoring diary. Contact the practice nurse or physician if you notice side effects before your next scheduled appointment."
  },
  {
    "subject": "Hospital discharge care summary and antibiotic dosing schedule",
    "text": "This care summary confirms the discharge instructions discussed with the ward physician and clinical pharmacist. Take the prescribed antibiotic medication with food at the scheduled times until the course is finished. Please bring this treatment record to your follow-up consultation at the medical clinic next week."
  },
  {
    "subject": "Annual health plan formulary update and generic prescription coverage",
    "text": "Our benefits administration team reviewed the covered prescription medication list for the upcoming plan year. Your approved generic cholesterol and hypertension treatment remains covered under the clinical formulary. Speak with your prescribing clinician or community pharmacist at your next consultation if you have questions about equivalent tablet options."
  },
  {
    "subject": "Laboratory blood test reminder and clinic appointment confirmation",
    "text": "You are scheduled for a routine fasting lipid panel and metabolic blood test at the medical clinic on Tuesday at 08:30 AM. Please drink only water for twelve hours before the appointment and take your regular morning medication unless instructed otherwise by your physician."
  },
  {
    "subject": "Monthly infrastructure invoice and payment confirmation for November",
    "text": "Thank you for your payment. Your monthly statement for compute instances, object storage and network transfer has been paid in full via your registered corporate billing method. A detailed PDF breakdown of usage hours and tax accounting is available in the billing console."
  },
  {
    "subject": "Hardware order dispatched: workstation replacement delivery schedule",
    "text": "Your IT equipment order has been dispatched from the regional distribution warehouse and is scheduled for office delivery on Wednesday afternoon. Someone at the reception desk will need to sign for the parcel upon arrival."
  },
  {
    "subject": "Platform security advisory: internal SSH certificate authority and TLS maintenance",
    "text": "The infrastructure security engineering team will rotate the internal bastion host keys and intermediate TLS certificates during Saturday's scheduled maintenance window at 03:00 UTC. Please update your local workstation configuration from the engineering repository and report any connection issues in the incident channel."
  },
  {
    "subject": "Security confirmation: WebAuthn hardware token registered on your workstation account",
    "text": "A new FIDO2 hardware security key was enrolled on your corporate directory profile during today's onboarding session. If you completed this registration with the IT helpdesk, no further action is required. Otherwise, contact the security operations desk immediately."
  },
  {
    "subject": "Payroll direct deposit advice and annual tax withholding summary",
    "text": "Your biweekly salary statement and retirement plan contribution record have been posted to the employee self-service portal. Please verify your residential address and federal withholding elections before the year-end payroll processing cutoff."
  },
  {
    "subject": "Third-quarter departmental operating expense reconciliation and budget forecast",
    "text": "Attached is the reconciled general ledger summary for engineering and operations through September. Please review the capital expenditure accruals and submit any cost-center adjustments to the accounting controller before Tuesday's close."
  },
  {
    "subject": "Protokoll der Architektur-Review und Freigabe des Wartungsfensters",
    "text": "Hallo zusammen, die Ergebnisse der gestrigen Lasttests und der Sicherheitsprüfung liegen nun vollständig vor. Alle Dienste laufen stabil innerhalb der vereinbarten Grenzen. Bitte überprüft die offenen Aufgaben bis Donnerstagmittag."
  },
  {
    "subject": "四半期システム監査および次期開発スケジュールのご連絡",
    "text": "お疲れ様です。来週火曜日の午前十時より、定例の設計レビュー会議を開催いたします。事前に共有フォルダ内の技術仕様書とテスト計画をご確認いただけますようお願いいたします。"
  },
  {
    "subject": "Recordatorio de consulta médica y revisión de tratamiento en la clínica",
    "text": "Estimado paciente, le recordamos su próxima cita con el médico de cabecera el jueves a las 09:30 de la mañana. Por favor traiga su documento de identidad y la lista actualizada de sus medicamentos habituales."
  },
  {
    "subject": "Engineering architecture review meeting agenda and quarterly roadmap planning",
    "text": "Please find your updated account and project review notes ready for tomorrow's session."
  },
  {
    "subject": "Operations committee schedule and internal compliance review notes",
    "text": "The updated documentation and account summary are available for the team meeting."
  }
] as const;
