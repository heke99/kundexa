export function PageHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return <div className="page-header"><div><h1>{title}</h1>{description ? <p>{description}</p> : null}</div>{action}</div>;
}
