import Link from "next/link";
export function ProductInformationLinks(){return <nav aria-label="Produktinformation" style={{display:"flex",gap:"1rem",flexWrap:"wrap",marginTop:"1.5rem"}}><Link href="/privacy">Personuppgifter och kakor</Link><Link href="/terms">Villkor</Link><Link href="/support">Hjälp och kontakt</Link></nav>;}
