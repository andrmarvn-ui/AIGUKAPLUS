create or replace function public.v8_report_v21_skip_unchanged_referral_update()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if row(
    old.page_id,old.sender_id,old.customer_id,old.conversation_id,
    old.message_id,old.referral_at,old.ad_id,old.ad_title,old.post_id,
    old.referral_source,old.source_payload
  ) is not distinct from row(
    new.page_id,new.sender_id,new.customer_id,new.conversation_id,
    new.message_id,new.referral_at,new.ad_id,new.ad_title,new.post_id,
    new.referral_source,new.source_payload
  ) then
    return null;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_report_v21_skip_unchanged_referral_update
  on public.v8_report_v21_referral_fact;

create trigger trg_v8_report_v21_skip_unchanged_referral_update
before update on public.v8_report_v21_referral_fact
for each row execute function public.v8_report_v21_skip_unchanged_referral_update();

revoke all on function public.v8_report_v21_skip_unchanged_referral_update() from public;
