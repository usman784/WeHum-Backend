/** Coarse regions for the lobby map (spec §7.2 `lobby:state.regions`). Only the ISO country is ever stored — no coordinates. */
const REGIONS: Record<string, string> = {};
const add = (region: string, codes: string) => { for (const c of codes.split(' ')) REGIONS[c] = region; };

add('Europe', 'AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK');
add('North America', 'AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI');
add('South America', 'AR BO BR CL CO EC FK GF GY PE PY SR UY VE');
add('Middle East', 'AE BH IL IQ IR JO KW LB OM PS QA SA SY TR YE');
add('Africa', 'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW');
add('Asia', 'AF AM AZ BD BN BT CN GE HK ID IN JP KG KH KP KR KZ LA LK MM MN MO MV MY NP PH PK SG TH TJ TL TM TW UZ VN');
add('Oceania', 'AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS');

export const regionOf = (country: string) => REGIONS[country] ?? 'Other';
export const ALL_REGIONS = ['Europe', 'North America', 'South America', 'Middle East', 'Africa', 'Asia', 'Oceania', 'Other'] as const;
