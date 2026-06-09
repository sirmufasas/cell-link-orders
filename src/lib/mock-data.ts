export type MockProduct = { id: string; name: string; sheetRow: number };
export type MockCustomer = {
  slug: string;
  name: string;
  area?: string;
  products: MockProduct[];
};

export const MOCK_CUSTOMERS: MockCustomer[] = [
  {
    slug: "brynston",
    name: "Brynston",
    area: "Sandton",
    products: [
      { id: "1", name: "PAO Rolls (doz)", sheetRow: 5 },
      { id: "2", name: "NATA (units)", sheetRow: 6 },
      { id: "3", name: "Burger Super (0.63)", sheetRow: 7 },
      { id: "4", name: "Long Rolls (0.58)", sheetRow: 8 },
    ],
  },
  {
    slug: "sandton",
    name: "Sandton",
    area: "Sandton",
    products: [
      { id: "1", name: "PAO Rolls (doz)", sheetRow: 12 },
      { id: "2", name: "NATA (units)", sheetRow: 13 },
      { id: "3", name: "Burger Super (0.63)", sheetRow: 14 },
      { id: "4", name: "Croissants", sheetRow: 15 },
      { id: "5", name: "Bread White Unslice", sheetRow: 16 },
    ],
  },
  {
    slug: "alberton-meat",
    name: "Alberton Meat",
    area: "Alberton",
    products: [
      { id: "1", name: "ROLLS doz", sheetRow: 2 },
      { id: "2", name: "LONG ROLLS (0.58)", sheetRow: 3 },
      { id: "3", name: "ROLLS CT doz", sheetRow: 4 },
      { id: "4", name: "PAO BIG", sheetRow: 5 },
      { id: "5", name: "BAGUETTES (PAO) EACH", sheetRow: 6 },
      { id: "6", name: "PAO ROLLS doz", sheetRow: 7 },
      { id: "7", name: "CROISANTS", sheetRow: 8 },
    ],
  },
];

export function getCustomer(slug: string) {
  return MOCK_CUSTOMERS.find((c) => c.slug === slug);
}
