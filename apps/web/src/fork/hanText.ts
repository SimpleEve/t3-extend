// fork: marks a 10px text node that renders Han so zhTypography.css can raise it to 11px; Latin
// and digits keep upstream's size.
export const hanTextProps = (text: string | undefined) =>
  text !== undefined && /\p{Script_Extensions=Han}/u.test(text)
    ? ({ "data-t3x-han-text": "" } as const)
    : {};
