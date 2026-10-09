/**
 * Demo products for development: realistic names, descriptions and prices for a local shop that
 * sells stationery, gifts, toys, sports and decoration items. Everything here is made up and meant
 * to be edited or replaced in the admin panel. Prices are in rupees (the seed script converts them).
 */

export type DemoCategory = 'stationery' | 'gift-items' | 'toys' | 'sports-items' | 'decoration-items';

export type DemoProduct = {
  category: DemoCategory;
  /** Last part of the SKU, e.g. "STA-001" becomes DK-STA-001. */
  code: string;
  name: string;
  description: string;
  mrp: number;
  price: number;
  stock: number;
  featured?: boolean;
  isNew?: boolean;
  /** How many pictures to make (default 1). */
  pictures?: 1 | 2 | 3;
};

export const DEMO_PRODUCTS: DemoProduct[] = [
  // ---- Stationery ----------------------------------------------------------------------
  {
    category: 'stationery', code: 'STA-101', name: 'Spiral Notebook A4, 200 Pages (Ruled)',
    description: 'A4 spiral-bound notebook with 200 ruled pages and a sturdy cover. The wire binding lets the pages fold flat, which makes it handy for school notes, office work and rough sketches.',
    mrp: 120, price: 99, stock: 80, pictures: 2,
  },
  {
    category: 'stationery', code: 'STA-102', name: 'Long Notebook 172 Pages, Pack of 6',
    description: 'Pack of six single-line long notebooks with 172 pages each. Smooth paper that takes ink well, and a stitched binding that holds up through the school year.',
    mrp: 360, price: 299, stock: 45, featured: true,
  },
  {
    category: 'stationery', code: 'STA-103', name: 'Ball Pen Pack, Blue (Pack of 20)',
    description: 'Twenty blue ball pens with a smooth, quick-drying ink flow and a comfortable grip. A practical bulk pack for students, offices and shops.',
    mrp: 100, price: 79, stock: 120,
  },
  {
    category: 'stationery', code: 'STA-104', name: 'Gel Pen Set, 10 Assorted Colours',
    description: 'Ten gel pens in bright colours with a fine 0.5 mm tip. Good for note-taking, journaling, drawing outlines and colour-coding.',
    mrp: 150, price: 119, stock: 60, isNew: true, pictures: 2,
  },
  {
    category: 'stationery', code: 'STA-105', name: 'HB Pencil Box, 10 Pencils with Eraser and Sharpener',
    description: 'A ready-to-use pencil box with ten HB pencils, a soft eraser and a sharpener. Dark, smooth writing that is easy to erase.',
    mrp: 70, price: 55, stock: 100,
  },
  {
    category: 'stationery', code: 'STA-106', name: 'Geometry Box, 9-Piece Metal Case',
    description: 'Metal geometry box with compass, divider, set squares, protractor, ruler, pencil and eraser. The hinged case keeps everything in place in a school bag.',
    mrp: 180, price: 149, stock: 35,
  },
  {
    category: 'stationery', code: 'STA-107', name: 'Highlighter Set, 6 Pastel Colours',
    description: 'Six pastel highlighters with a chisel tip for wide or fine lines. The soft colours mark text clearly without hiding it.',
    mrp: 180, price: 139, stock: 40, isNew: true,
  },
  {
    category: 'stationery', code: 'STA-108', name: 'Sticky Notes, 5 Colours (500 Sheets)',
    description: 'Five neon and pastel pads of sticky notes, 500 sheets in all. They hold firmly and peel off cleanly for reminders, bookmarks and to-do lists.',
    mrp: 140, price: 109, stock: 50,
  },
  {
    category: 'stationery', code: 'STA-109', name: 'Colour Pencils, 24 Shades',
    description: 'A tin of 24 colour pencils with soft, pigmented leads that blend well. A good first set for school art and drawing practice.',
    mrp: 220, price: 179, stock: 38, featured: true, pictures: 3,
  },
  {
    category: 'stationery', code: 'STA-110', name: 'Mesh Desk Organiser, 3 Compartments',
    description: 'Metal-mesh desk organiser with three compartments for pens, scissors and small supplies. Keeps a study table or counter tidy.',
    mrp: 299, price: 249, stock: 22,
  },

  // ---- Gift items ------------------------------------------------------------------------
  {
    category: 'gift-items', code: 'GFT-101', name: 'Printed Ceramic Coffee Mug, 325 ml',
    description: 'Glossy ceramic mug with a cheerful printed design and a comfortable handle. A simple gift for birthdays, thank-yous and office desks.',
    mrp: 349, price: 249, stock: 40, isNew: true, pictures: 2,
  },
  {
    category: 'gift-items', code: 'GFT-102', name: 'Wooden Photo Frame, 6 x 8 inch',
    description: 'Wooden tabletop photo frame for a 6 x 8 inch picture, with a clear front and a fold-out stand. Works on a shelf, desk or bedside.',
    mrp: 449, price: 349, stock: 25,
  },
  {
    category: 'gift-items', code: 'GFT-103', name: 'Gift Hamper Box with Ribbon, Medium',
    description: 'A sturdy medium-size gift box with a lid and satin ribbon. Fill it with your own presents for a neat, ready-to-give hamper.',
    mrp: 299, price: 229, stock: 30,
  },
  {
    category: 'gift-items', code: 'GFT-104', name: 'Scented Candle Set, Lavender (3 pcs)',
    description: 'Set of three lavender-scented candles in small glass jars. A calm, pleasant fragrance for gifting or for the living room.',
    mrp: 499, price: 399, stock: 35, featured: true, pictures: 3,
  },
  {
    category: 'gift-items', code: 'GFT-105', name: 'Greeting Card Pack, Assorted (Set of 10)',
    description: 'Ten blank-inside greeting cards in assorted designs with matching envelopes. Suitable for birthdays, festivals and thank-you notes.',
    mrp: 250, price: 199, stock: 60,
  },
  {
    category: 'gift-items', code: 'GFT-106', name: 'Gift Wrapping Paper, 10 Sheets',
    description: 'Ten large sheets of printed gift wrapping paper in mixed patterns. Thick enough to wrap neatly without tearing.',
    mrp: 150, price: 119, stock: 70,
  },
  {
    category: 'gift-items', code: 'GFT-107', name: 'Keychain and Pen Gift Set',
    description: 'A metal keychain and a matching pen in a presentation box. A neat, practical gift for colleagues and friends.',
    mrp: 399, price: 299, stock: 28,
  },
  {
    category: 'gift-items', code: 'GFT-108', name: 'Mini Succulent Planter, Ceramic Pot',
    description: 'Small decorative ceramic pot with a drainage plug, sized for a desk or windowsill. Plant not included.',
    mrp: 249, price: 199, stock: 33, isNew: true,
  },
  {
    category: 'gift-items', code: 'GFT-109', name: 'Diary and Pen Combo, Hardcover',
    description: 'Hardcover diary with ruled pages and a ribbon bookmark, packed with a matching pen. A thoughtful gift for students and professionals.',
    mrp: 549, price: 449, stock: 20, featured: true,
  },
  {
    category: 'gift-items', code: 'GFT-110', name: 'Wooden Jewellery Box, Two Layers',
    description: 'Two-layer wooden box with a lined interior and a latch, for rings, earrings and small accessories.',
    mrp: 599, price: 449, stock: 15,
  },

  // ---- Toys ------------------------------------------------------------------------------
  {
    category: 'toys', code: 'TOY-101', name: 'Building Blocks, 120 Pieces',
    description: 'Colourful interlocking blocks in a storage tub, 120 pieces in all. Encourages building, counting and imaginative play. Suitable for ages 3 and above.',
    mrp: 599, price: 449, stock: 40, featured: true, pictures: 3,
  },
  {
    category: 'toys', code: 'TOY-102', name: 'Soft Teddy Bear, 30 cm',
    description: 'A soft, huggable teddy bear with a stitched face and plush filling. A gentle companion for bedtime and a popular gift.',
    mrp: 499, price: 379, stock: 30, pictures: 2,
  },
  {
    category: 'toys', code: 'TOY-103', name: 'Remote Control Car, Rechargeable',
    description: 'Fast remote control car with a rechargeable battery pack and a USB charging cable. Handles turns smoothly on floors and pavements.',
    mrp: 1299, price: 999, stock: 18, featured: true,
  },
  {
    category: 'toys', code: 'TOY-104', name: 'Jigsaw Puzzle, 48 Pieces',
    description: 'A 48-piece jigsaw puzzle with large, thick pieces and a bright picture. Builds patience and shape recognition for young children.',
    mrp: 249, price: 189, stock: 45,
  },
  {
    category: 'toys', code: 'TOY-105', name: 'Pull-Back Cars, Set of 6',
    description: 'Six small pull-back cars in different colours. Pull back, let go, and they race ahead. Good for races and party return gifts.',
    mrp: 349, price: 269, stock: 55,
  },
  {
    category: 'toys', code: 'TOY-106', name: 'Modelling Clay, 12 Colours',
    description: 'Soft modelling clay in twelve colours with a few shaping tools. Easy to mould and keep soft when the tubs are closed after play.',
    mrp: 199, price: 149, stock: 65, isNew: true,
  },
  {
    category: 'toys', code: 'TOY-107', name: 'Board Game, Ludo and Snakes & Ladders',
    description: 'Two classic family games on a folding board with counters and dice. Quick to learn and fun for two to four players.',
    mrp: 299, price: 229, stock: 38,
  },
  {
    category: 'toys', code: 'TOY-108', name: 'Doctor Play Set, 15 Pieces',
    description: 'A pretend doctor kit with a stethoscope, thermometer and other tools in a carry case. Encourages role play.',
    mrp: 449, price: 349, stock: 24,
  },
  {
    category: 'toys', code: 'TOY-109', name: 'Colouring Book and Crayons Combo',
    description: 'A large colouring book with bold outline pictures and a box of wax crayons. Keeps little hands busy and builds drawing skills.',
    mrp: 199, price: 149, stock: 70,
  },
  {
    category: 'toys', code: 'TOY-110', name: 'Bubble Gun with Solution',
    description: 'Battery-powered bubble gun that blows streams of bubbles, supplied with a bottle of solution. An outdoor favourite.',
    mrp: 399, price: 299, stock: 26, isNew: true,
  },

  // ---- Sports items ----------------------------------------------------------------------
  {
    category: 'sports-items', code: 'SPT-101', name: 'Cricket Bat, Kashmir Willow (Size 5)',
    description: 'Kashmir willow cricket bat in size 5 with a rubber grip. Suitable for tennis-ball and leather-ball play at club and practice level.',
    mrp: 1999, price: 1599, stock: 12, pictures: 2,
  },
  {
    category: 'sports-items', code: 'SPT-102', name: 'Tennis Cricket Balls, Pack of 6',
    description: 'Six durable tennis balls for gully and box cricket, with a good bounce and a tough cover.',
    mrp: 399, price: 299, stock: 50,
  },
  {
    category: 'sports-items', code: 'SPT-103', name: 'Football, Size 5',
    description: 'Machine-stitched size 5 football with a synthetic cover and good grip. Holds its shape on grass and hard ground.',
    mrp: 799, price: 649, stock: 25, featured: true,
  },
  {
    category: 'sports-items', code: 'SPT-104', name: 'Badminton Racket Pair with Cover',
    description: 'Pair of lightweight aluminium badminton rackets with a padded grip and a shared carry cover. A good set for casual games.',
    mrp: 899, price: 699, stock: 20,
  },
  {
    category: 'sports-items', code: 'SPT-105', name: 'Nylon Shuttlecocks, Tube of 6',
    description: 'Six nylon shuttlecocks in a tube. Durable for practice and everyday play on indoor and outdoor courts.',
    mrp: 349, price: 279, stock: 48,
  },
  {
    category: 'sports-items', code: 'SPT-106', name: 'Adjustable Skipping Rope',
    description: 'Skipping rope with foam handles and an adjustable length. A simple way to build stamina and coordination.',
    mrp: 199, price: 149, stock: 60,
  },
  {
    category: 'sports-items', code: 'SPT-107', name: 'Yoga Mat, 6 mm Anti-Slip',
    description: '6 mm thick anti-slip yoga mat with a textured surface and a carry strap. Cushions joints during exercise and stretching.',
    mrp: 799, price: 599, stock: 28, featured: true, isNew: true, pictures: 2,
  },
  {
    category: 'sports-items', code: 'SPT-108', name: 'Dumbbell Set, 2 x 2 kg',
    description: 'A pair of 2 kg vinyl-coated dumbbells with a non-slip finish. Suitable for light home workouts.',
    mrp: 699, price: 549, stock: 18,
  },
  {
    category: 'sports-items', code: 'SPT-109', name: 'Carrom Board, Medium, with Coins',
    description: 'Medium carrom board with a smooth playing surface, striker, coins and powder. A family favourite for evenings and holidays.',
    mrp: 1499, price: 1199, stock: 10,
  },
  {
    category: 'sports-items', code: 'SPT-110', name: 'Sports Water Bottle, 750 ml',
    description: '750 ml BPA-free sports bottle with a leak-resistant flip lid and a carry loop. Easy to refill and clean.',
    mrp: 349, price: 249, stock: 55,
  },

  // ---- Decoration items ------------------------------------------------------------------
  {
    category: 'decoration-items', code: 'DEC-101', name: 'Artificial Flower Bunch Set, 6 pcs',
    description: 'Six bunches of artificial flowers that look good in a vase and need no watering. Brightens shelves, tables and entrances.',
    mrp: 399, price: 299, stock: 35,
  },
  {
    category: 'decoration-items', code: 'DEC-102', name: 'LED String Lights, 5 m Warm White',
    description: '5 metre string of warm white LED lights with a plug-in adapter. Use them on walls, windows and plants, and for festivals and parties.',
    mrp: 399, price: 299, stock: 60, featured: true, pictures: 3,
  },
  {
    category: 'decoration-items', code: 'DEC-103', name: 'Round Wall Clock, 30 cm',
    description: 'Silent-sweep 30 cm round wall clock with a clear dial. Runs on one AA battery (not included).',
    mrp: 699, price: 549, stock: 20,
  },
  {
    category: 'decoration-items', code: 'DEC-104', name: 'Decorative Cushion Covers, Pack of 2',
    description: 'Two cushion covers in a soft woven fabric with a hidden zip. Fits a 16 x 16 inch cushion. Filler not included.',
    mrp: 499, price: 379, stock: 40,
  },
  {
    category: 'decoration-items', code: 'DEC-105', name: 'Table Lamp with Wooden Base',
    description: 'Bedside or desk lamp with a wooden base and a fabric shade, for a standard bulb (not included).',
    mrp: 999, price: 799, stock: 14, isNew: true, pictures: 2,
  },
  {
    category: 'decoration-items', code: 'DEC-106', name: 'Floral Wall Stickers, Set',
    description: 'Self-adhesive floral wall stickers that peel and stick on smooth, clean walls. Adds colour to a bedroom or living room without any tools.',
    mrp: 299, price: 229, stock: 45,
  },
  {
    category: 'decoration-items', code: 'DEC-107', name: 'Ceramic Flower Vase, Medium',
    description: 'Medium glazed ceramic vase with a weighted base. Works with fresh or artificial flowers.',
    mrp: 549, price: 429, stock: 22, featured: true,
  },
  {
    category: 'decoration-items', code: 'DEC-108', name: 'Birthday Decoration Kit, Balloons and Banner',
    description: 'Party kit with assorted balloons, a Happy Birthday banner and ribbon. Everything needed to set up a quick birthday corner.',
    mrp: 449, price: 349, stock: 30, isNew: true,
  },
  {
    category: 'decoration-items', code: 'DEC-109', name: 'Photo Collage Wall Frame Set of 6',
    description: 'Set of six frames in different sizes for a gallery-style wall. Includes hanging hooks and a layout guide.',
    mrp: 799, price: 599, stock: 16,
  },
  {
    category: 'decoration-items', code: 'DEC-110', name: 'Fairy Light Curtain, 3 m',
    description: '3 metre curtain of warm fairy lights with hanging strands. Looks lovely behind a bed, on a window or at a celebration.',
    mrp: 599, price: 449, stock: 25,
  },
];
