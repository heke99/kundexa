import type { LucideIcon } from "@/components/icons";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
export function ModuleOverview({title,description,icon:Icon,features,children,status='Aktiv modul'}:{title:string;description:string;icon:LucideIcon;features:string[];children?:React.ReactNode;status?:string}){return <><PageHeader title={title} description={description}/><div className="grid grid-2"><Card><CardHeader><h2><Icon size={17}/> Funktioner</h2><Badge className="badge-success">{status}</Badge></CardHeader><CardContent><div className="grid grid-2">{features.map(x=><div className="notice" key={x}>{x}</div>)}</div></CardContent></Card>{children}</div></>}
