/**
 * Fake prescribing information for a fake drug. Owned by the Story lane.
 * Everything the voice agent says about the drug must come from here.
 */
export const STELAZIO_LABEL = {
  product: "Stelazio",
  generic: "stelazivir tablets",
  updated: "2026-09-18",
  sections: [
    {
      number: "1",
      title: "Indications and usage",
      text: "Stelazio is indicated to reduce the risk of cardiovascular death and hospitalization for heart failure in adults with chronic heart failure with reduced ejection fraction. It is used in addition to standard therapy.",
    },
    {
      number: "2.1",
      title: "Recommended dosage",
      text: "The recommended starting dose is 10 mg once daily with or without food. Tablets should be swallowed whole. If a dose is missed, take it as soon as remembered on the same day, then resume the usual schedule.",
    },
    {
      number: "2.3",
      title: "Dosage in renal impairment",
      text: "For patients with an estimated glomerular filtration rate below 45 mL/min/1.73 m², reduce the dose to 5 mg once daily. Monitor renal function at baseline and every 3 months. No dose adjustment is needed for eGFR 45 or above. Stelazio is not recommended below eGFR 20.",
    },
    {
      number: "4",
      title: "Contraindications",
      text: "Stelazio is contraindicated in patients with known hypersensitivity to stelazivir and during pregnancy.",
    },
    {
      number: "5.1",
      title: "Hypotension",
      text: "Symptomatic hypotension may occur, particularly in volume-depleted patients or those on high-dose diuretics. Correct volume depletion before starting and monitor blood pressure after initiation.",
    },
    {
      number: "5.2",
      title: "Hyperkalemia",
      text: "Serum potassium may increase, particularly in patients with renal impairment or those taking potassium supplements or potassium-sparing diuretics. Check potassium within 2 weeks of starting and periodically thereafter.",
    },
    {
      number: "6",
      title: "Adverse reactions",
      text: "The most common adverse reactions, occurring in at least 5 percent of patients, are dizziness, hyperkalemia, and hypotension.",
    },
    {
      number: "7",
      title: "Drug interactions",
      text: "Avoid concomitant use with strong CYP3A4 inhibitors such as ketoconazole and clarithromycin, which increase stelazivir exposure. If unavoidable, reduce to 5 mg once daily.",
    },
    {
      number: "8.1",
      title: "Pregnancy",
      text: "Stelazio may cause fetal harm and is contraindicated in pregnancy. Discontinue as soon as pregnancy is detected.",
    },
    {
      number: "16",
      title: "Samples and supply",
      text: "Professional samples are available to licensed prescribers in accordance with the Prescription Drug Marketing Act. Sample requests require a valid state license and are limited to 2 cartons of 14 tablets per request.",
    },
  ],
};
