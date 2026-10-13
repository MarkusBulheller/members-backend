/** Which racing sim an event runs in — iRacing has its own catalog sync, series and weather data
 * hooked in, Le Mans Ultimate events are plain hand-entered events with none of that. */
export enum Sim {
  IRACING = 'IRACING',
  LMU = 'LMU',
}
