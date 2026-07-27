export interface Coordinates { readonly latitude: number; readonly longitude: number }
export interface LocationHint { readonly label: string; readonly coordinates?: Coordinates }