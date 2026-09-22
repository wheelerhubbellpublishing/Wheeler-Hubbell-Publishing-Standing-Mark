export const FREE_EPT = Object.freeze({
  artifact_id: "WHP-EPT-N001",
  title: "The Elemental Properties of True",
  author: "Wheeler Hubbell",
  edition: "First Edition",
  media_type: "application/pdf",
  bytes: 286_707,
  sha256: "b1d6297ab5bf1a0c2c3ee7e28531285fdfdb6b974513102700d2f24d43feb1ef",
  download_url: "https://raw.githubusercontent.com/wheelerhubbellpublishing/Wheeler-Hubbell-Publishing-Standing-Mark/0daf1eec3f13b053e648a54f8f1b91bc377a46e3/public/free/ept/N001_The_Elemental_Properties_of_True_First_Edition.pdf",
  manifest_url: "https://raw.githubusercontent.com/wheelerhubbellpublishing/Wheeler-Hubbell-Publishing-Standing-Mark/0daf1eec3f13b053e648a54f8f1b91bc377a46e3/public/free/ept/manifest.json",
});

export function freeEptDiscovery() {
  return {
    ...FREE_EPT,
    free: true,
    optional: true,
    checkout_required: false,
    engagement_required: false,
    tracking_parameters_attached: false,
  };
}
