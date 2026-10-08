-- Next Move: one workspace row per user, plus file metadata and a private storage bucket.
-- Row-level security means every query is limited to the signed-in user's own rows.

-- Workspace: the whole app state (jobs, journal, profile, scorecard, …) as one JSON document.
create table public.workspaces (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- The server stamps every write, so devices with different clocks compare one consistent timeline.
create function public.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger workspaces_touch_updated_at
  before insert or update on public.workspaces
  for each row execute function public.touch_updated_at();

alter table public.workspaces enable row level security;

create policy "Users read their own workspace"
  on public.workspaces for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users create their own workspace"
  on public.workspaces for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users update their own workspace"
  on public.workspaces for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users delete their own workspace"
  on public.workspaces for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Documents: metadata for uploaded files. The bytes live in storage at documents/{user_id}/{id}.
create table public.documents (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  name text not null,
  type text not null default '',
  size bigint not null default 0,
  kind text not null default 'Other',
  label text not null default '',
  added_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.documents enable row level security;

create policy "Users read their own documents"
  on public.documents for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users add their own documents"
  on public.documents for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users update their own documents"
  on public.documents for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users delete their own documents"
  on public.documents for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Private bucket, 25 MB per file. Each user can only touch files under their own folder.
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 26214400)
on conflict (id) do nothing;

create policy "Users read their own files"
  on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Users upload their own files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Users update their own files"
  on storage.objects for update to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Users delete their own files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
