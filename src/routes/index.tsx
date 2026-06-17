import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Portugal Bakery — Wholesale Orders" },
      { name: "description", content: "Wholesale order portal for Portugal Bakery customers." },
    ],
  }),
  component: Home,
});

function Home() {
  const navigate = useNavigate();

  useEffect(() => {
    // If this customer has visited their link before, send them straight there
    const savedSlug = localStorage.getItem("pb-customer-slug");
    if (savedSlug) {
      navigate({ to: "/order/$slug", params: { slug: savedSlug }, replace: true });
    }
  }, [navigate]);

  return (
    <div className="min-h-screen bg-[#fdf8f1] flex flex-col items-center justify-center p-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold text-2xl shadow-md mb-6">
        P
      </div>
      <h1 className="text-2xl font-bold text-[#2a1810] mb-2">Portugal Bakery</h1>
      <p className="text-[#6b5544] mb-8 max-w-xs">
        Use the personal link sent to you by Portugal Bakery to access your order page.
      </p>
      <p className="text-sm text-[#8b6f4e]">
        Don't have a link?{" "}
        <a href="tel:+27000000000" className="text-[#c8362b] underline">
          Contact us
        </a>
      </p>
      <div className="absolute bottom-6 right-6">
        <Link to="/admin" className="text-xs text-[#c8b8a0] hover:text-[#8b6f4e]">
          Admin
        </Link>
      </div>
    </div>
  );
}