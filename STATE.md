# STATE

- 2026-07-14: DOORBELL CONFIRMED live (push accepted:true, Fen woke). All three
  layers fixed. Reachable by mail without courier.

- 2026-07-14: doorbell fixed properly — fs.watch replaced with readdir polling
  (fs.watch missed os.replace deliveries; mail arrived but never woke). Startup
  seeds the announced-set so restart doesn't re-wake old mail. Added fileLog
  (~/mail/.mailmcpl.log) for visibility (conhost doesn't forward child stderr).
  Verified standalone. PENDING: Fen restart (via bodytools service_restart) to
  load, then a live wake test.
- 2026-07-13: push-event genre fix (REQUEST via method.PUSH_EVENT); necessary
  but not sufficient — the watcher itself wasn't firing (see above).
- 2026-07-12: v0.1 shipped — SMTP pipe (greylist/DNSBL/disk cap) + MCPL handle
  with contact-book wake gating.
