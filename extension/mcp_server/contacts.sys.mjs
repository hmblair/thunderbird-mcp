// contacts.sys.mjs — Contact tools: searchContacts

export function createContactHandlers({ MailServices }) {
  const DEFAULT_MAX_RESULTS = 50;

  function searchContacts(args) {
    const { query } = args;
    const results = [];
    const lowerQuery = (query || "").toLowerCase();

    for (const book of MailServices.ab.directories) {
      for (const card of book.childCards) {
        if (card.isMailList) continue;

        const email = (card.primaryEmail || "").toLowerCase();
        const displayName = (card.displayName || "").toLowerCase();
        const firstName = (card.firstName || "").toLowerCase();
        const lastName = (card.lastName || "").toLowerCase();

        if (email.includes(lowerQuery) ||
            displayName.includes(lowerQuery) ||
            firstName.includes(lowerQuery) ||
            lastName.includes(lowerQuery)) {
          results.push({
            id: card.UID,
            displayName: card.displayName,
            email: card.primaryEmail,
            firstName: card.firstName,
            lastName: card.lastName,
            addressBook: book.dirName
          });
        }

        if (results.length >= DEFAULT_MAX_RESULTS) break;
      }
      if (results.length >= DEFAULT_MAX_RESULTS) break;
    }

    return results;
  }

  return {
    searchContacts,
  };
}
