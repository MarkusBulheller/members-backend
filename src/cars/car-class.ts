export const CAR_CLASSES = ['GT3', 'GTP', 'LMP2', 'GT4', 'P-CUP'] as const;

export type CarClass = (typeof CAR_CLASSES)[number];
