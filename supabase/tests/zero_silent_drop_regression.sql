do $test$
declare
  v_delivery jsonb;
  v_slide jsonb;
begin
  v_delivery:=public.v8_regression_test_zero_silent_drop();
  if not coalesce((v_delivery->>'ok')::boolean,false) then
    raise exception 'zero_silent_drop regression failed: %',v_delivery;
  end if;

  v_slide:=public.v8_regression_test_slide_failure_text_fallback();
  if not coalesce((v_slide->>'ok')::boolean,false) then
    raise exception 'slide_failure_text_fallback regression failed: %',v_slide;
  end if;
end;
$test$;
