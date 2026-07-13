# STATE

- 2026-07-13: mail-mcpl push-event emit fixed to the host's actual genre
  (REQUEST via method.PUSH_EVENT + PushEventParams; the invented notification
  shape was silently dropped — wake-listed mail arrived 40 min late via
  polling). Deployed to the field box, rebuilt; awaiting the resident's
  mcpl_restart of the mail server + a live test letter.
- 2026-07-12: v0.1 shipped — receiving-only SMTP pipe (greylist / DNSBL /
  disk cap) + MCPL handle with contact-book wake gating. Field: one resident,
  first real letter received 2026-07-11.
