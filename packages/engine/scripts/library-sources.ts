/**
 * What goes in the asset library: openly licensed (CC0) models and textures,
 * picked by hand for range (homes, shops, markets, streets, transport, people), each with a
 * label and tags that describe what it *looks like*, so a model can choose it for whatever a
 * world says a thing is. Nothing here says what anything does in a game.
 *
 * Sources: Poly Haven (photoreal props and textures), Quaternius (low-poly furniture, market
 * stalls, nature, rigged people), KayKit (low-poly cars and street furniture). All CC0.
 */

export interface PolyHavenModel {
  from: "polyhaven";
  id: string;
  ph: string;
  label: string;
  tags: string[];
}

export interface QuaterniusModel {
  from: "quaternius";
  id: string;
  /** Path under the showcase's public/glb. */
  path: string;
  label: string;
  tags: string[];
}

export interface KayKitModel {
  from: "kaykit";
  id: string;
  /** File name in KayKit City Builder Bits' gltf folder, without extension. */
  name: string;
  label: string;
  tags: string[];
}

export type ThingSource = PolyHavenModel | QuaterniusModel | KayKitModel;

export interface OutfitSource {
  id: string;
  path: string;
  label: string;
  tags: string[];
  slots: { skin: string[]; hair: string[]; top: string[]; bottom: string[] };
}

export interface SurfaceSource {
  id: string;
  ph: string;
  label: string;
  tags: string[];
  tintable: boolean;
  use: "floor" | "wall" | "both";
}

const ph = (id: string, phId: string, label: string, tags: string[]): PolyHavenModel => ({
  from: "polyhaven",
  id,
  ph: phId,
  label,
  tags,
});
const q = (id: string, path: string, label: string, tags: string[]): QuaterniusModel => ({
  from: "quaternius",
  id,
  path,
  label,
  tags,
});
const kk = (id: string, name: string, label: string, tags: string[]): KayKitModel => ({
  from: "kaykit",
  id,
  name,
  label,
  tags,
});

const o = (
  id: string,
  path: string,
  label: string,
  tags: string[],
  skin: string[],
  hair: string[],
  top: string[],
  bottom: string[],
): OutfitSource => ({ id, path, label, tags, slots: { skin, hair, top, bottom } });

export const THINGS: ThingSource[] = [
  // ── Photoreal props (Poly Haven) ────────────────────────────────────────────────────────
  ph("petrol_generator", "portable_generator", "Portable petrol generator", [
    "power",
    "engine",
    "outdoor",
  ]),
  ph("monobloc_chair", "plastic_monobloc_chair_01", "White plastic monobloc chair", [
    "seat",
    "chair",
    "plastic",
  ]),
  ph("plastic_jerrycan", "plastic_jerrycan", "Plastic jerrycan", ["container", "fuel", "water"]),
  ph("metal_jerrycan", "metal_jerrycan", "Metal jerrycan", ["container", "fuel"]),
  ph("gas_cylinder_small", "small_lpg_tank", "Small gas cylinder", ["cooking gas", "cylinder"]),
  ph("gas_cylinder", "propane_tank", "Gas cylinder", ["cooking gas", "cylinder"]),
  ph("boombox", "boombox", "Boombox radio", ["music", "speaker", "electronics"]),
  ph("ceiling_fan", "ceiling_fan", "Ceiling fan", ["fan", "cooling", "electric"]),
  ph("electric_cooker", "electric_stove", "Electric cooker with oven", [
    "kitchen",
    "stove",
    "cooking",
  ]),
  ph("barrel_stove", "barrel_stove", "Barrel stove", ["cooking", "fire", "outdoor"]),
  ph("crt_television", "Television_01", "Old box television", ["tv", "screen", "electronics"]),
  ph("television", "television_02", "Television set", ["tv", "screen", "electronics"]),
  ph("covered_car", "covered_car", "Car under a cover", ["vehicle", "car", "parked"]),
  ph("dustbin", "metal_trash_can", "Metal dustbin", ["rubbish", "bin", "outdoor"]),
  ph("plastic_crate", "plastic_crate_01", "Plastic crate", ["crate", "storage", "drinks"]),
  ph("cardboard_box", "cardboard_box_01", "Cardboard box", ["box", "storage", "goods"]),
  ph("old_tyre", "old_tyre", "Old tyre", ["tyre", "vehicle", "junk"]),
  ph("street_lamp", "street_lamp_01", "Street lamp", ["light", "street", "pole"]),
  ph("folding_stool", "folding_wooden_stool", "Folding wooden stool", ["seat", "stool", "wood"]),
  ph("wooden_bench", "painted_wooden_bench", "Painted wooden bench", ["seat", "bench", "wood"]),
  ph("wooden_table", "painted_wooden_table", "Painted wooden table", ["table", "wood"]),
  ph("round_table", "round_wooden_table_01", "Round wooden table", ["table", "wood", "dining"]),
  ph("patio_set", "outdoor_table_chair_set_01", "Outdoor table and chairs", [
    "table",
    "chairs",
    "outdoor",
  ]),
  ph("cash_register", "CashRegister_01", "Cash register", ["shop", "counter", "money"]),
  ph("steel_shelves", "steel_frame_shelves_01", "Steel shelving", ["shelves", "storage", "shop"]),
  ph("sofa", "Sofa_01", "Fabric sofa", ["seat", "sofa", "living room"]),
  ph("sofa_leather", "sofa_02", "Leather sofa", ["seat", "sofa", "living room"]),
  ph("armchair", "ArmChair_01", "Armchair", ["seat", "chair", "living room"]),
  ph("coffee_table", "CoffeeTable_01", "Coffee table", ["table", "living room"]),
  ph("school_desk", "SchoolDesk_01", "School desk", ["desk", "school", "study"]),
  ph("school_chair", "SchoolChair_01", "School chair", ["seat", "chair", "school"]),
  ph("office_desk", "metal_office_desk", "Office desk", ["desk", "office", "work"]),
  ph("laptop", "classic_laptop", "Laptop", ["computer", "work", "electronics"]),
  ph("chalkboard", "standing_chalkboard_01", "Standing chalkboard", ["board", "sign", "menu"]),
  ph("barber_chair", "BarberShopChair_01", "Barber's chair", ["seat", "salon", "barber"]),
  ph("potted_plant", "potted_plant_04", "Potted plant", ["plant", "decor"]),
  ph("metal_drum", "Barrel_01", "Metal drum", ["barrel", "container", "water"]),
  ph("cooking_pot", "pot_enamel_01", "Enamel cooking pot", ["pot", "cooking", "kitchen"]),
  ph("water_bottle_big", "plastic_bottle_gallon", "Big water bottle", [
    "water",
    "drink",
    "container",
  ]),
  ph("food_cart", "CoffeeCart_01", "Street food cart", ["vendor", "food", "cart"]),
  ph("chest_of_drawers", "drawer_cabinet", "Chest of drawers", ["storage", "bedroom"]),
  ph("meter_box", "power_box_01", "Electric meter box", ["power", "meter", "wall"]),
  // ── Low-poly home (Quaternius) ──────────────────────────────────────────────────────────
  q("bed_single", "house_interior_pack/Bed_Single", "Single bed", ["bed", "sleep", "bedroom"]),
  q("bed_double", "house_interior_pack/Bed_King", "Double bed", ["bed", "sleep", "bedroom"]),
  q("bunk_bed", "house_interior_pack/Bed_Bunk", "Bunk bed", ["bed", "sleep", "hostel"]),
  q("bathtub", "house_interior_pack/Bathroom_Bathtub", "Bathtub", ["bath", "wash", "bathroom"]),
  q("shower", "house_interior_pack/Bathroom_Shower1", "Shower cubicle", [
    "shower",
    "wash",
    "bathroom",
  ]),
  q("wash_basin", "house_interior_pack/Bathroom_Sink", "Wash basin", ["sink", "wash", "bathroom"]),
  q("toilet", "house_interior_pack/Bathroom_Toilet", "Toilet", ["toilet", "bathroom"]),
  q("washing_machine", "house_interior_pack/Bathroom_WashingMachine", "Washing machine", [
    "laundry",
    "wash",
    "appliance",
  ]),
  q("fridge", "house_interior_pack/Kitchen_Fridge", "Fridge", ["kitchen", "cold", "appliance"]),
  q("cooker", "house_interior_pack/Kitchen_Oven", "Cooker", ["kitchen", "stove", "cooking"]),
  q("kitchen_sink", "house_interior_pack/Kitchen_Sink", "Kitchen sink unit", [
    "kitchen",
    "sink",
    "wash",
  ]),
  q("kitchen_counter", "house_interior_pack/Kitchen_2Drawers", "Kitchen counter", [
    "kitchen",
    "counter",
  ]),
  q("kitchen_cabinet", "house_interior_pack/Kitchen_Cabinet1", "Wall cabinet", [
    "kitchen",
    "storage",
  ]),
  q("bookshelf", "house_interior_pack/Bookshelf", "Bookshelf", ["books", "storage"]),
  q("couch_large", "house_interior_pack/Couch_Large1", "Large couch", [
    "seat",
    "sofa",
    "living room",
  ]),
  q("couch_small", "house_interior_pack/Couch_Small1", "Loveseat", ["seat", "sofa", "living room"]),
  q("dining_chair", "house_interior_pack/Chair_1", "Dining chair", ["seat", "chair", "dining"]),
  q("dining_table", "house_interior_pack/Table_RoundLarge", "Dining table", ["table", "dining"]),
  q("drawers", "house_interior_pack/Drawer_1", "Drawers", ["storage", "bedroom"]),
  q("nightstand", "house_interior_pack/NightStand_1", "Bedside table", ["table", "bedroom"]),
  q("rug", "house_interior_pack/Carpet_1", "Rug", ["rug", "floor", "decor"]),
  q("curtains", "house_interior_pack/Curtains_Double", "Curtains", ["window", "decor"]),
  q("houseplant", "house_interior_pack/Houseplant_3", "Houseplant", ["plant", "decor"]),
  q("floor_lamp", "house_interior_pack/Light_Floor1", "Floor lamp", ["light", "lamp"]),
  q("desk_lamp", "house_interior_pack/Light_Desk", "Desk lamp", ["light", "lamp"]),
  q("wall_shelf", "house_interior_pack/Shelf_Large", "Wall shelf", ["shelf", "storage"]),
  q("stool", "house_interior_pack/Stool", "Bar stool", ["seat", "stool"]),
  q("bin", "house_interior_pack/Trashcan_Large", "Bin", ["rubbish", "bin"]),
  // ── Low-poly tools, electronics, market (Quaternius) ────────────────────────────────────
  q("split_ac", "cyberpunk_pack/AC", "Air conditioner unit", ["cooling", "electric", "wall"]),
  q("computer", "cyberpunk_pack/Computer", "Desktop computer", ["computer", "work", "electronics"]),
  q("antenna", "cyberpunk_pack/Antenna_1", "Roof antenna", ["signal", "roof"]),
  q("radio", "survival_pack/Radio", "Radio", ["music", "news", "electronics"]),
  q("pot", "survival_pack/Pot", "Cooking pot", ["pot", "cooking"]),
  q("mobile_phone", "survival_pack/Phone", "Mobile phone", ["phone", "electronics"]),
  q("frying_pan", "survival_pack/Pan", "Frying pan", ["pan", "cooking"]),
  q("tent", "survival_pack/Tent", "Tent", ["shelter", "outdoor"]),
  q("campfire", "survival_pack/Bonfire_Fire", "Open fire", ["fire", "cooking", "outdoor"]),
  q("market_stall", "medieval_village_pack/MarketStand_1", "Market stall with awning", [
    "market",
    "stall",
    "vendor",
  ]),
  q("market_stall_2", "medieval_village_pack/MarketStand_2", "Market stall", [
    "market",
    "stall",
    "vendor",
  ]),
  q("handcart", "medieval_village_pack/Cart", "Wooden handcart", ["cart", "goods", "vendor"]),
  q("sacks", "medieval_village_pack/Bags", "Sacks of goods", ["sacks", "goods", "market"]),
  q("wooden_crate", "medieval_village_pack/Crate", "Wooden crate", ["crate", "goods", "storage"]),
  q("barrel", "medieval_village_pack/Barrel", "Wooden barrel", ["barrel", "storage"]),
  q("well", "medieval_village_pack/Well", "Water well", ["water", "well", "outdoor"]),
  q("garden_bench", "medieval_village_pack/Bench_1", "Garden bench", ["seat", "bench", "outdoor"]),
  q("streetlight", "street_pack/Streetlight_Single", "Streetlight", ["light", "street", "pole"]),
  q("traffic_light", "street_pack/TrafficLight", "Traffic light", ["street", "road", "signal"]),
  q("palm_tree", "nature_pack/PalmTree_1", "Palm tree", ["tree", "palm", "outdoor"]),
  q("palm_tree_2", "nature_pack/PalmTree_3", "Tall palm tree", ["tree", "palm", "outdoor"]),
  q("shade_tree", "nature_pack/CommonTree_1", "Shade tree", ["tree", "outdoor"]),
  q("bush", "nature_pack/Bush_1", "Bush", ["plant", "bush", "outdoor"]),
  q("flowers", "nature_pack/Flowers", "Flower bed", ["plant", "flowers", "outdoor"]),
  q("rock", "nature_pack/Rock_1", "Rock", ["rock", "outdoor"]),
  // ── Low-poly vehicles and street (KayKit) ───────────────────────────────────────────────
  kk("car_sedan", "car_sedan", "Saloon car", ["vehicle", "car"]),
  kk("car_taxi", "car_taxi", "Taxi", ["vehicle", "car", "taxi"]),
  kk("car_hatchback", "car_hatchback", "Hatchback car", ["vehicle", "car"]),
  kk("car_estate", "car_stationwagon", "Estate car", ["vehicle", "car"]),
  kk("car_police", "car_police", "Police car", ["vehicle", "car", "police"]),
  kk("dumpster", "dumpster", "Large rubbish skip", ["rubbish", "street"]),
  kk("fire_hydrant", "firehydrant", "Fire hydrant", ["street", "water"]),
];

/** Rigged people (Quaternius Ultimate Modular Men and Women). Slots are their material names. */
export const OUTFITS: OutfitSource[] = [
  o(
    "man_tshirt",
    "modular_men/Casual",
    "Man in a T-shirt and jeans",
    ["man", "casual"],
    ["Skin"],
    ["Hair"],
    ["Purple"],
    ["LightBlue"],
  ),
  o(
    "man_shirt",
    "modular_men/Casual2",
    "Man in a shirt and jeans",
    ["man", "casual"],
    ["Skin", "Skin_Darker"],
    ["Hair"],
    ["LightBrown"],
    ["LightBlue"],
  ),
  o(
    "man_suit",
    "modular_men/Suit",
    "Man in a suit and tie",
    ["man", "formal", "office"],
    ["Skin"],
    ["Hair"],
    ["Suit"],
    [],
  ),
  o(
    "man_worker",
    "modular_men/Worker",
    "Man in work clothes and a hard hat",
    ["man", "work", "builder"],
    ["Skin"],
    [],
    ["LightBrown"],
    ["Brown2"],
  ),
  o(
    "man_farmer",
    "modular_men/Farmer",
    "Man in overalls and a hat",
    ["man", "work", "farm"],
    ["Skin"],
    [],
    ["LightBlue"],
    [],
  ),
  o(
    "man_beach",
    "modular_men/Beach",
    "Man in an open shirt and shorts",
    ["man", "casual", "beach"],
    ["Skin"],
    ["Hair"],
    ["LightBrown"],
    ["Red_Dark"],
  ),
  o(
    "man_punk",
    "modular_men/Punk",
    "Young man in a vest and jeans",
    ["man", "young", "street"],
    ["Skin"],
    ["Red"],
    ["White"],
    ["LightBlue"],
  ),
  o(
    "man_hiker",
    "modular_men/Adventurer",
    "Man with a backpack",
    ["man", "travel"],
    ["Skin"],
    ["Hair"],
    ["Green"],
    ["Brown2"],
  ),
  o(
    "woman_casual",
    "modular_women/Casual",
    "Woman in a top and trousers",
    ["woman", "casual"],
    ["Skin"],
    ["Hair_Brown", "Hair_Blond"],
    ["White"],
    ["Orange"],
  ),
  o(
    "woman_dress",
    "modular_women/Formal",
    "Woman in a long dress",
    ["woman", "formal", "dress"],
    ["Skin"],
    ["Red"],
    ["LimeGreen"],
    [],
  ),
  o(
    "woman_suit",
    "modular_women/Suit",
    "Woman in a trouser suit",
    ["woman", "formal", "office"],
    ["Skin"],
    ["Hair_Brown", "Hair_Blond"],
    ["White"],
    [],
  ),
  o(
    "woman_worker",
    "modular_women/Worker",
    "Woman in work clothes and a hard hat",
    ["woman", "work", "builder"],
    ["Skin"],
    ["DarkBrown"],
    ["White"],
    ["Brown_02", "Brown2"],
  ),
  o(
    "woman_street",
    "modular_women/Punk",
    "Young woman in streetwear",
    ["woman", "young", "street"],
    ["Skin"],
    ["Hair_Brown"],
    ["Pink"],
    [],
  ),
  o(
    "woman_hiker",
    "modular_women/Adventurer",
    "Woman in outdoor clothes",
    ["woman", "travel"],
    ["Skin"],
    ["Hair_Brown"],
    ["Green"],
    ["LightGreen"],
  ),
];

/** Floors, ground and walls (Poly Haven). */
export const SURFACES: SurfaceSource[] = [
  {
    id: "floor_tiles",
    ph: "floor_tiles_06",
    label: "Glazed floor tiles",
    tags: ["tiles", "indoor", "clean"],
    tintable: false,
    use: "floor",
  },
  {
    id: "white_tiles",
    ph: "long_white_tiles",
    label: "Long white tiles",
    tags: ["tiles", "bathroom", "kitchen"],
    tintable: false,
    use: "both",
  },
  {
    id: "marble_tiles",
    ph: "marble_tiles",
    label: "Marble tiles",
    tags: ["tiles", "smart", "indoor"],
    tintable: false,
    use: "floor",
  },
  {
    id: "terrazzo",
    ph: "mixed_stone_tiles",
    label: "Stone chip tiles",
    tags: ["tiles", "terrazzo"],
    tintable: false,
    use: "floor",
  },
  {
    id: "laminate",
    ph: "laminate_floor_02",
    label: "Laminate wood floor",
    tags: ["wood", "indoor"],
    tintable: false,
    use: "floor",
  },
  {
    id: "parquet",
    ph: "herringbone_parquet",
    label: "Herringbone parquet",
    tags: ["wood", "indoor", "smart"],
    tintable: false,
    use: "floor",
  },
  {
    id: "planks",
    ph: "dark_wooden_planks",
    label: "Dark wooden planks",
    tags: ["wood", "boards"],
    tintable: false,
    use: "both",
  },
  {
    id: "vinyl",
    ph: "linoleum_brown",
    label: "Patterned vinyl floor",
    tags: ["vinyl", "indoor", "cheap"],
    tintable: false,
    use: "floor",
  },
  {
    id: "cement_floor",
    ph: "concrete_floor_worn_001",
    label: "Worn cement floor",
    tags: ["cement", "concrete", "plain"],
    tintable: false,
    use: "floor",
  },
  {
    id: "painted_concrete",
    ph: "painted_concrete",
    label: "Painted concrete",
    tags: ["concrete", "painted"],
    tintable: true,
    use: "both",
  },
  {
    id: "asphalt",
    ph: "asphalt_02",
    label: "Asphalt road",
    tags: ["road", "street", "outdoor"],
    tintable: false,
    use: "floor",
  },
  {
    id: "pavers",
    ph: "patterned_paving",
    label: "Interlocking paving stones",
    tags: ["paving", "compound", "outdoor"],
    tintable: false,
    use: "floor",
  },
  {
    id: "red_earth",
    ph: "cracked_red_ground",
    label: "Red laterite earth",
    tags: ["earth", "ground", "outdoor"],
    tintable: false,
    use: "floor",
  },
  {
    id: "dirt",
    ph: "dirt",
    label: "Bare dirt",
    tags: ["earth", "ground", "outdoor"],
    tintable: false,
    use: "floor",
  },
  {
    id: "grass",
    ph: "grass_ground",
    label: "Grass",
    tags: ["grass", "garden", "outdoor"],
    tintable: false,
    use: "floor",
  },
  {
    id: "sand",
    ph: "damp_beach_sand",
    label: "Beach sand",
    tags: ["sand", "beach", "outdoor"],
    tintable: false,
    use: "floor",
  },
  {
    id: "plaster",
    ph: "painted_plaster_wall",
    label: "Painted plaster wall",
    tags: ["plaster", "painted"],
    tintable: true,
    use: "wall",
  },
  {
    id: "smooth_plaster",
    ph: "plastered_wall",
    label: "Smooth plastered wall",
    tags: ["plaster", "painted", "smooth"],
    tintable: true,
    use: "wall",
  },
  {
    id: "peeling_paint",
    ph: "peeling_painted_wall",
    label: "Peeling painted wall",
    tags: ["plaster", "old", "worn"],
    tintable: false,
    use: "wall",
  },
  {
    id: "block_wall",
    ph: "concrete_brick_wall_001",
    label: "Bare concrete block wall",
    tags: ["blocks", "unfinished"],
    tintable: false,
    use: "wall",
  },
  {
    id: "zinc_sheet",
    ph: "corrugated_iron",
    label: "Corrugated iron sheet",
    tags: ["metal", "zinc", "shack"],
    tintable: false,
    use: "wall",
  },
  {
    id: "red_brick",
    ph: "brick_wall_02",
    label: "Red brick wall",
    tags: ["brick"],
    tintable: false,
    use: "wall",
  },
  {
    id: "wall_tiles",
    ph: "granite_tile_03",
    label: "Wall tiles",
    tags: ["tiles", "kitchen", "bathroom"],
    tintable: false,
    use: "wall",
  },
];

/** Buildings for the city map (Quaternius, textured low-poly). Heights are real metres. */
export const BUILDINGS: ThingSource[] = [
  kk("painted_2_small", "building_A_withoutBase", "Small painted two-storey building", [
    "building",
    "house",
    "shop",
    "colourful",
  ]),
  kk("painted_2_wide", "building_B_withoutBase", "Painted two-storey building", [
    "building",
    "house",
    "shop",
    "colourful",
  ]),
  kk("painted_3_small", "building_C_withoutBase", "Narrow painted three-storey building", [
    "building",
    "flats",
    "colourful",
  ]),
  kk("painted_3", "building_D_withoutBase", "Painted three-storey building", [
    "building",
    "flats",
    "shop",
    "colourful",
  ]),
  kk("painted_3_wide", "building_E_withoutBase", "Wide painted three-storey block", [
    "building",
    "flats",
    "office",
    "colourful",
  ]),
  kk("painted_3_wide_2", "building_F_withoutBase", "Wide painted three-storey building", [
    "building",
    "flats",
    "shop",
    "colourful",
  ]),
  kk("painted_3_wide_3", "building_G_withoutBase", "Wide painted three-storey block with shops", [
    "building",
    "shop",
    "flats",
    "colourful",
  ]),
  kk("painted_4", "building_H_withoutBase", "Painted four-storey block", [
    "building",
    "flats",
    "office",
    "colourful",
  ]),
  q("shop_1", "buildings_pack_3/1Story_Sign_Mat", "One-storey shop with a sign", [
    "building",
    "shop",
    "street",
  ]),
  q("house_1", "buildings_pack_3/1Story_Mat", "One-storey flat-roofed building", [
    "building",
    "house",
  ]),
  q(
    "house_gable",
    "buildings_pack_3/1Story_GableRoof_Mat",
    "One-storey house with a pitched roof",
    ["building", "house"],
  ),
  q("hall_round", "buildings_pack_3/1Story_RoundRoof_Mat", "One-storey hall with a curved roof", [
    "building",
    "hall",
    "market",
  ]),
  q("shop_2", "buildings_pack_3/2Story_Sign_Mat", "Two-storey shop building with a sign", [
    "building",
    "shop",
    "office",
  ]),
  q("flats_balcony", "buildings_pack_3/2Story_Balcony_Mat", "Two-storey building with balconies", [
    "building",
    "flats",
    "house",
  ]),
  q("flats_2", "buildings_pack_3/2Story_Mat", "Two-storey building", ["building", "flats"]),
  q(
    "flats_wide",
    "buildings_pack_3/2Story_Wide_2Doors_Mat",
    "Wide two-storey block with two doors",
    ["building", "flats", "office"],
  ),
  q("columns_2", "buildings_pack_3/2Story_Columns_Mat", "Two-storey building with columns", [
    "building",
    "civic",
    "church",
    "bank",
  ]),
  q("house_stairs", "buildings_pack_3/2Story_Stairs_Mat", "Two-storey house with outside stairs", [
    "building",
    "house",
  ]),
  q("block_3", "buildings_pack_3/3Story_Balcony_Mat", "Three-storey block with balconies", [
    "building",
    "flats",
  ]),
  q("block_3_slim", "buildings_pack_3/3Story_Slim_Mat", "Narrow three-storey building", [
    "building",
    "flats",
    "office",
  ]),
  q("office_4", "buildings_pack_3/4Story_Mat", "Four-storey office block", [
    "building",
    "office",
    "tech",
  ]),
  q(
    "office_4_wide",
    "buildings_pack_3/4Story_Wide_2Doors_Roof_Mat",
    "Wide four-storey block with a roof terrace",
    ["building", "office", "hotel", "club"],
  ),
  q("tower_6", "buildings_pack_3/6Story_Stack_Mat", "Six-storey tower", [
    "building",
    "office",
    "tower",
  ]),
  q("inn", "medieval_village_pack/Inn", "Old timber inn", ["building", "bar", "restaurant"]),
  q("bell_tower", "medieval_village_pack/Bell_Tower", "Bell tower", [
    "building",
    "church",
    "tower",
  ]),
  q("gazebo", "medieval_village_pack/Gazebo", "Open gazebo", [
    "building",
    "shelter",
    "beach",
    "park",
  ]),
  q("stable", "medieval_village_pack/Stable", "Open-sided shed", [
    "building",
    "garage",
    "park",
    "shed",
  ]),
];

/**
 * Real heights in metres, where a source's own units aren't real-world (low-poly packs are
 * modelled at arbitrary scales). The catalog's sizes are scaled so the height matches; models
 * pick by real size and decor is placed at it.
 */
export const REAL_HEIGHT_M: Record<string, number> = {
  antenna: 1.2,
  barrel: 0.9,
  bathtub: 0.6,
  bed_double: 0.6,
  bed_single: 0.55,
  bin: 0.8,
  bookshelf: 1.9,
  bunk_bed: 1.7,
  bush: 1.0,
  campfire: 0.6,
  car_estate: 1.5,
  car_hatchback: 1.45,
  car_police: 1.6,
  car_sedan: 1.45,
  car_taxi: 1.6,
  computer: 0.45,
  cooker: 0.9,
  couch_large: 0.85,
  couch_small: 0.85,
  curtains: 2.3,
  desk_lamp: 0.45,
  dining_chair: 0.9,
  dining_table: 0.76,
  drawers: 0.8,
  dumpster: 1.3,
  fire_hydrant: 0.7,
  floor_lamp: 1.6,
  flowers: 0.4,
  fridge: 1.8,
  frying_pan: 0.08,
  garden_bench: 0.85,
  handcart: 0.9,
  houseplant: 0.9,
  kitchen_cabinet: 0.7,
  kitchen_counter: 0.92,
  kitchen_sink: 0.95,
  market_stall: 2.4,
  market_stall_2: 2.4,
  nightstand: 0.55,
  palm_tree: 6,
  palm_tree_2: 7.5,
  pot: 0.3,
  radio: 0.25,
  rock: 0.6,
  rug: 0.02,
  sacks: 0.6,
  shade_tree: 5.5,
  shower: 2.1,
  split_ac: 0.6,
  steel_shelves: 1.8,
  stool: 0.75,
  streetlight: 5,
  tent: 2.0,
  toilet: 0.8,
  traffic_light: 3.5,
  wall_shelf: 1.8,
  wash_basin: 0.9,
  washing_machine: 0.85,
  well: 1.0,
  wooden_crate: 0.5,
  mobile_phone: 0.15,
  painted_2_small: 7,
  painted_2_wide: 7,
  painted_3_small: 10,
  painted_3: 10,
  painted_3_wide: 10,
  painted_3_wide_2: 10,
  painted_3_wide_3: 10,
  painted_4: 13,
  shop_1: 4,
  house_1: 3.6,
  house_gable: 5,
  hall_round: 5,
  shop_2: 7,
  flats_balcony: 7,
  flats_2: 7,
  flats_wide: 7,
  columns_2: 8,
  house_stairs: 7,
  block_3: 10,
  block_3_slim: 10,
  office_4: 13,
  office_4_wide: 14,
  tower_6: 20,
  inn: 9,
  bell_tower: 14,
  gazebo: 4,
  stable: 4,
};
