alter table public.v9_runtime_config
  add column if not exists ingest_mode text not null default 'DIRECT_CORE'
  check (ingest_mode in ('DIRECT_CORE','LEGACY_BRIDGE','OFF'));

update public.v9_runtime_config
set ingest_mode='DIRECT_CORE',updated_at=now()
where id=1;

create or replace function public.v9_ingest_meta_batch(p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_items jsonb;
  v_input jsonb;
  v_config public.v9_runtime_config%rowtype;
  v_page_mode text;
  v_coexistence_mode text;
  v_source_system text;
  v_source_event_id text;
  v_page_id text;
  v_sender_id text;
  v_recipient_id text;
  v_customer_id text;
  v_message_id text;
  v_actor_type text;
  v_event_type text;
  v_message_text text;
  v_actor_app_id text;
  v_registry_provider text;
  v_actor_evidence jsonb;
  v_attachments jsonb;
  v_referral jsonb;
  v_payload jsonb;
  v_occurred_at timestamptz;
  v_received_at timestamptz;
  v_event_id uuid;
  v_decision_eligible boolean;
  v_phone text;
  v_contact_captured boolean;
  v_deadline timestamptz;
  v_inserted integer:=0;
  v_duplicates integer:=0;
  v_skipped integer:=0;
  v_failed integer:=0;
  v_results jsonb:='[]'::jsonb;
begin
  if p_events is null then
    return jsonb_build_object('ok',true,'inserted',0,'duplicates',0,'skipped',0,'failed',0,'results','[]'::jsonb);
  end if;

  v_items:=case
    when jsonb_typeof(p_events)='array' then p_events
    when jsonb_typeof(p_events)='object' then jsonb_build_array(p_events)
    else '[]'::jsonb
  end;

  select * into v_config from public.v9_runtime_config where id=1;
  if not found or v_config.mode='OFF' or v_config.ingest_mode='OFF' then
    return jsonb_build_object('ok',false,'error','V9_INGEST_DISABLED','inserted',0,'duplicates',0,'skipped',jsonb_array_length(v_items),'failed',0,'results','[]'::jsonb);
  end if;

  for v_input in select value from jsonb_array_elements(v_items)
  loop
    begin
      v_source_system:=coalesce(nullif(v_input->>'source_system',''),'meta_webhook');
      v_source_event_id:=nullif(v_input->>'source_event_id','');
      v_page_id:=nullif(v_input->>'page_id','');
      v_sender_id:=nullif(v_input->>'sender_id','');
      v_recipient_id:=nullif(v_input->>'recipient_id','');
      v_customer_id:=nullif(v_input->>'customer_id','');
      v_message_id:=nullif(v_input->>'message_id','');
      v_actor_type:=coalesce(nullif(v_input->>'actor_type',''),'unknown');
      v_event_type:=coalesce(nullif(v_input->>'event_type',''),'unknown');
      v_message_text:=nullif(v_input->>'message_text','');
      v_actor_app_id:=nullif(v_input->>'actor_app_id','');
      v_actor_evidence:=case when jsonb_typeof(v_input->'actor_evidence')='object' then v_input->'actor_evidence' else '{}'::jsonb end;
      v_attachments:=case when jsonb_typeof(v_input->'attachments')='array' then v_input->'attachments' else '[]'::jsonb end;
      v_referral:=case when jsonb_typeof(v_input->'referral')='object' then v_input->'referral' else null end;
      v_payload:=case when jsonb_typeof(v_input->'payload')='object' then v_input->'payload' else '{}'::jsonb end;
      v_decision_eligible:=coalesce((v_input->>'decision_eligible')::boolean,false);
      v_occurred_at:=coalesce(nullif(v_input->>'occurred_at','')::timestamptz,now());
      v_received_at:=coalesce(nullif(v_input->>'received_at','')::timestamptz,now());
      v_phone:=regexp_replace(coalesce(v_input->>'contact_phone',''),'[^0-9]','','g');
      if left(v_phone,2)='84' then v_phone:='0'||substr(v_phone,3); end if;
      if v_phone !~ '^0[0-9]{9}$' then v_phone:=null; end if;
      v_contact_captured:=v_phone is not null;

      if v_source_event_id is null or v_page_id is null then
        v_skipped:=v_skipped+1;
        v_results:=v_results||jsonb_build_array(jsonb_build_object('source_event_id',v_source_event_id,'status','skipped','reason','MISSING_EVENT_OR_PAGE_ID'));
        continue;
      end if;

      select operating_mode,coexistence_mode
      into v_page_mode,v_coexistence_mode
      from public.v9_pages
      where page_id=v_page_id and is_active;
      if not found or v_page_mode='OFF' then
        v_skipped:=v_skipped+1;
        v_results:=v_results||jsonb_build_array(jsonb_build_object('source_event_id',v_source_event_id,'status','skipped','reason','PAGE_NOT_ACTIVE'));
        continue;
      end if;

      if v_actor_type not in ('customer','sale','admin','automation','bot','page_unknown','unknown') then
        v_actor_type:='unknown';
      end if;

      if v_actor_type='page_unknown' and v_actor_app_id is not null then
        select r.actor_type,r.provider
        into v_actor_type,v_registry_provider
        from public.v9_actor_registry r
        where r.is_active
          and r.app_id=v_actor_app_id
          and (r.page_id=v_page_id or r.page_id is null)
        order by (r.page_id=v_page_id) desc,r.confidence desc,r.updated_at desc
        limit 1;
        if found then
          v_actor_evidence:=v_actor_evidence||jsonb_build_object(
            'method','v9_actor_registry',
            'provider',v_registry_provider,
            'human_verified',v_actor_type in ('sale','admin'),
            'app_id',v_actor_app_id
          );
          v_event_type:=case
            when v_actor_type in ('sale','admin') then 'human_message'
            when v_actor_type='automation' then 'automation_message'
            when v_actor_type='bot' then 'bot_message'
            else v_event_type
          end;
        else
          v_actor_type:='page_unknown';
        end if;
      end if;

      insert into public.v9_events(
        source_system,source_event_id,page_id,sender_id,customer_id,recipient_id,
        message_id,actor_type,actor_evidence,event_type,message_text,attachments,
        referral,occurred_at,received_at,payload
      ) values (
        v_source_system,v_source_event_id,v_page_id,v_sender_id,v_customer_id,v_recipient_id,
        v_message_id,v_actor_type,v_actor_evidence,v_event_type,v_message_text,v_attachments,
        v_referral,v_occurred_at,v_received_at,v_payload
      )
      on conflict(source_system,source_event_id) do nothing
      returning id into v_event_id;

      if v_event_id is null then
        v_duplicates:=v_duplicates+1;
        v_results:=v_results||jsonb_build_array(jsonb_build_object('source_event_id',v_source_event_id,'status','duplicate'));
        continue;
      end if;

      if v_customer_id is not null then
        insert into public.v9_customers(
          page_id,customer_id,first_seen_at,last_seen_at,profile,created_at,updated_at
        ) values (
          v_page_id,v_customer_id,v_occurred_at,v_occurred_at,
          jsonb_build_object('source','meta_webhook'),now(),now()
        )
        on conflict(page_id,customer_id) do update set
          last_seen_at=greatest(public.v9_customers.last_seen_at,excluded.last_seen_at),
          profile=public.v9_customers.profile||excluded.profile,
          updated_at=now();
      end if;

      if v_actor_type='customer' and v_customer_id is not null then
        if v_contact_captured then
          insert into public.v9_contacts(
            page_id,customer_id,contact_type,contact_value,normalized_value,
            source_event_id,confidence,captured_at
          ) values (
            v_page_id,v_customer_id,'phone',v_phone,v_phone,v_source_event_id,1,v_occurred_at
          )
          on conflict(page_id,customer_id,contact_type,normalized_value) do nothing;
        end if;

        v_deadline:=case
          when v_contact_captured then v_occurred_at
          else v_received_at+make_interval(secs=>v_config.response_sla_seconds)
        end;

        insert into public.v9_conversation_state(
          page_id,sender_id,state,version,contact_status,phone,human_takeover,
          last_customer_event_at,response_deadline_at,last_source_event_id,updated_at
        ) values (
          v_page_id,v_customer_id,
          case when v_contact_captured then 'CONTACT_CAPTURED' else 'RECEIVED' end,
          1,
          case when v_contact_captured then 'captured' else 'missing' end,
          v_phone,false,v_occurred_at,v_deadline,v_source_event_id,now()
        )
        on conflict(page_id,sender_id) do update set
          state=case
            when public.v9_conversation_state.contact_status='captured' or excluded.contact_status='captured' then 'CONTACT_CAPTURED'
            else 'RECEIVED'
          end,
          version=public.v9_conversation_state.version+1,
          contact_status=case
            when public.v9_conversation_state.contact_status='captured' or excluded.contact_status='captured' then 'captured'
            else 'missing'
          end,
          phone=coalesce(excluded.phone,public.v9_conversation_state.phone),
          human_takeover=false,
          human_takeover_until=null,
          last_customer_event_at=greatest(coalesce(public.v9_conversation_state.last_customer_event_at,'epoch'::timestamptz),excluded.last_customer_event_at),
          response_deadline_at=excluded.response_deadline_at,
          last_source_event_id=excluded.last_source_event_id,
          updated_at=now();

        insert into public.v9_shadow_observations(
          source_event_id,page_id,sender_id,actor_type,event_type,contact_detection,state_after,goal
        ) values (
          v_source_event_id,v_page_id,v_customer_id,v_actor_type,v_event_type,
          jsonb_build_object(
            'phones',case when v_phone is null then '[]'::jsonb else jsonb_build_array(v_phone) end,
            'primaryPhone',v_phone,
            'hasPhone',v_contact_captured,
            'contactCaptured',v_contact_captured,
            'evidence',case when v_contact_captured then 'phone_in_customer_text' else null end
          ),
          case when v_contact_captured then 'CONTACT_CAPTURED' else 'RECEIVED' end,
          v_config.contact_goal
        )
        on conflict(source_event_id) do nothing;

        if v_decision_eligible then
          insert into public.v9_sla_events(
            source_event_id,page_id,sender_id,deadline_at,status,resolution,resolved_at,updated_at
          ) values (
            v_source_event_id,v_page_id,v_customer_id,v_deadline,
            case when v_contact_captured then 'resolved' else 'open' end,
            case when v_contact_captured then 'contact_captured' else null end,
            case when v_contact_captured then v_received_at else null end,
            now()
          )
          on conflict(source_event_id) do nothing;

          if not v_contact_captured then
            update public.v9_jobs
            set status='cancelled',completed_at=now(),last_error='superseded_by_new_customer_event',updated_at=now()
            where page_id=v_page_id and sender_id=v_customer_id
              and job_type='decision_shadow' and status='queued';

            insert into public.v9_jobs(
              source_event_id,event_id,job_type,dedupe_key,page_id,sender_id,status,
              run_after,payload,created_at,updated_at
            ) values (
              v_source_event_id,v_event_id,'decision_shadow',
              v_page_id||':'||v_customer_id||':'||v_source_event_id,
              v_page_id,v_customer_id,'queued',
              v_received_at+make_interval(secs=>v_config.debounce_seconds),
              jsonb_build_object(
                'goal',v_config.contact_goal,
                'mode','SHADOW',
                'coexistence_mode',v_coexistence_mode,
                'source','direct_meta_ingest'
              ),
              now(),now()
            )
            on conflict(source_event_id,job_type) do nothing;
          end if;
        end if;
      elsif v_customer_id is not null then
        insert into public.v9_conversation_state(
          page_id,sender_id,state,version,human_takeover,human_takeover_until,
          last_page_event_at,last_source_event_id,updated_at
        ) values (
          v_page_id,v_customer_id,
          case when v_actor_type in ('sale','admin') then 'ANSWERED_BY_HUMAN' else 'PAGE_ACTIVITY' end,
          1,
          v_actor_type in ('sale','admin'),
          case when v_actor_type in ('sale','admin') then v_received_at+make_interval(secs=>v_config.human_takeover_seconds) else null end,
          v_occurred_at,v_source_event_id,now()
        )
        on conflict(page_id,sender_id) do update set
          state=case
            when excluded.human_takeover then 'ANSWERED_BY_HUMAN'
            else public.v9_conversation_state.state
          end,
          version=public.v9_conversation_state.version+1,
          human_takeover=public.v9_conversation_state.human_takeover or excluded.human_takeover,
          human_takeover_until=case when excluded.human_takeover then excluded.human_takeover_until else public.v9_conversation_state.human_takeover_until end,
          last_page_event_at=greatest(coalesce(public.v9_conversation_state.last_page_event_at,'epoch'::timestamptz),excluded.last_page_event_at),
          last_source_event_id=excluded.last_source_event_id,
          updated_at=now();

        if v_actor_type in ('sale','admin','automation','bot') then
          update public.v9_sla_events
          set status='resolved',resolution=v_event_type,resolved_at=v_received_at,updated_at=now()
          where page_id=v_page_id and sender_id=v_customer_id and status='open';

          update public.v9_jobs
          set status='cancelled',completed_at=now(),last_error='response_observed:'||v_actor_type,updated_at=now()
          where page_id=v_page_id and sender_id=v_customer_id
            and job_type='decision_shadow' and status='queued';
        end if;
      end if;

      v_inserted:=v_inserted+1;
      v_results:=v_results||jsonb_build_array(jsonb_build_object(
        'source_event_id',v_source_event_id,
        'status','inserted',
        'event_id',v_event_id,
        'actor_type',v_actor_type,
        'event_type',v_event_type,
        'decision_eligible',v_decision_eligible,
        'contact_captured',v_contact_captured
      ));
    exception when others then
      v_failed:=v_failed+1;
      v_results:=v_results||jsonb_build_array(jsonb_build_object(
        'source_event_id',coalesce(v_source_event_id,v_input->>'source_event_id'),
        'status','failed',
        'error',left(sqlerrm,300)
      ));
    end;
  end loop;

  return jsonb_build_object(
    'ok',v_failed=0,
    'inserted',v_inserted,
    'duplicates',v_duplicates,
    'skipped',v_skipped,
    'failed',v_failed,
    'results',v_results
  );
end;
$$;

revoke all on function public.v9_ingest_meta_batch(jsonb) from public,anon,authenticated;
grant execute on function public.v9_ingest_meta_batch(jsonb) to service_role;

comment on function public.v9_ingest_meta_batch(jsonb) is
  'Atomic idempotent Meta ingest into V9 Core. No network calls and no outbound side effects.';
