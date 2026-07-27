-- Enum values must be committed before later migrations/functions use them.
alter type public.delivery_status add value if not exists 'clicked';
alter type public.delivery_status add value if not exists 'delayed';
alter type public.delivery_status add value if not exists 'bounced';
alter type public.delivery_status add value if not exists 'complained';
alter type public.delivery_status add value if not exists 'suppressed';
alter type public.delivery_status add value if not exists 'dead_letter';
