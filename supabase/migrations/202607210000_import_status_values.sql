begin;

alter type public.import_status add value if not exists 'parsing';
alter type public.import_status add value if not exists 'mapping_required';
alter type public.import_status add value if not exists 'validated';
alter type public.import_status add value if not exists 'queued';
alter type public.import_status add value if not exists 'completed_with_warnings';
alter type public.import_status add value if not exists 'cancelled';

commit;
