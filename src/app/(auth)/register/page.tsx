import { redirect } from "next/navigation";

export default function RegisterPage() {
  redirect("/login?message=Publik registrering är stängd. Konton skapas av Kundexa eller er tenantadministratör.");
}
