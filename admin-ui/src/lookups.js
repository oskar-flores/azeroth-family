// characters.class / characters.race are numeric IDs. WotLK has 10 playable
// classes (1-9 and 11; 10 is unused) and 10 playable races (1-8, 10, 11; 9 is
// unused). Names are the Spanish forms an esES client renders, because the
// family page is the only place these appear.
const CLASSES = new Map([
  [1, 'Guerrero'], [2, 'Paladín'], [3, 'Cazador'], [4, 'Pícaro'], [5, 'Sacerdote'],
  [6, 'Caballero de la Muerte'], [7, 'Chamán'], [8, 'Mago'], [9, 'Brujo'], [11, 'Druida'],
]);

const RACES = new Map([
  [1, 'Humano'], [2, 'Orco'], [3, 'Enano'], [4, 'Elfo de la noche'], [5, 'No-muerto'],
  [6, 'Tauren'], [7, 'Gnomo'], [8, 'Trol'], [10, 'Elfo de sangre'], [11, 'Draenei'],
]);

export const className = (id) => CLASSES.get(Number(id)) ?? `Clase ${id}`;
export const raceName = (id) => RACES.get(Number(id)) ?? `Raza ${id}`;