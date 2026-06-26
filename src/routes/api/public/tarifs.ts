type Tarif = {
    id: string;
    label: string;
    montant: number;
    description?: string;
    actif?: boolean;
};

type TarifsPayload = {
    saison: string | null;
    tarifs: Tarif[];
    updated_at?: string;
};

type AppContext = {
    request: Request;
    env: { DB?: D1Database };
};

export async function onRequestGet({ env }: AppContext): Promise<Response> {
    const db = env.DB as D1Database | undefined;
    let pricing: Record<string, number> = {};

    if (db) {
        const row = await db
        .prepare("SELECT valeur FROM club_info WHERE cle = 'inscription_pricing' LIMIT 1")
        .first<{ valeur: string }>();
        if (row?.valeur) {
            try { pricing = JSON.parse(row.valeur); } catch { /* fallback vide */ }
        }
    }

    return new Response(JSON.stringify({ pricing }), {
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache, no-store",
        },
    });
}
