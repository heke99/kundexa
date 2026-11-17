import Link from "next/link";
import { Logo } from "@/components/logo";
import { ProductInformationLinks } from "@/components/product-information-links";
export default function InformationLayout({children}:{children:React.ReactNode}){return <main className="landing" style={{maxWidth:900,margin:"0 auto",padding:"2rem"}}><nav className="landing-nav"><Logo/><Link href="/login">Logga in</Link></nav><article style={{lineHeight:1.7,margin:"3rem 0"}}>{children}</article><ProductInformationLinks/></main>;}
