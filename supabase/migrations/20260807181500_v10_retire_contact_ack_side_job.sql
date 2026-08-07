drop trigger if exists v10_enqueue_new_contact_ack_job on public.v9_contacts;

comment on function aiguka_private.v10_enqueue_new_contact_ack_job() is
  'Retired in V10: contact capture no longer creates an immediate standalone decision job. Contact messages are merged by the authoritative customer-cluster debounce in public.v9_ingest_meta_batch.';
