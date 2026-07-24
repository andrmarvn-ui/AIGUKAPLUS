# Supabase regression tests

Apply migrations in timestamp order, then run:

```sql
\i supabase/tests/zero_silent_drop_regression.sql
```

The tests create isolated synthetic customers, exercise the real triggers and staging functions, and delete all generated rows before returning. They must never be run concurrently with another copy of the same test file.
