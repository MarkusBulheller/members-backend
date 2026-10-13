export const CAR_CLASSES = ['GT3', 'GTP', 'LMP2', 'GT4', 'P-CUP', 'Hypercar', 'LMGT3'] as const;

export type CarClass = (typeof CAR_CLASSES)[number];
