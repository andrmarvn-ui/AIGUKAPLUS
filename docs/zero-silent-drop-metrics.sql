-- Overall health
select public.v8_response_obligation_status();

-- Any customer turns that remain unresolved outside an explicit Sale escalation
select o.*,c.display_name
from public.v8_response_obligations o
left join public.v8_customers c on c.id=o.customer_id
where not o.is_resolved
  and o.obligation_status<>'escalation_required'
order by o.inbound_at;

-- Rescue tasks that require a human response
select t.*,c.display_name
from public.v8_sale_tasks t
left join public.v8_customers c on c.id=t.customer_id
where t.task_type='bot_delivery_rescue'
  and t.status in ('open','assigned','in_progress')
order by t.priority desc,t.due_at;

-- Pipeline failures recovered through safe fallback
select *
from public.v8_ai_delivery_sla_events
where action='safe_text_fallback'
order by created_at desc;
