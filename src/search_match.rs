//! Shared, network-free matching for music metadata and typeahead results.
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

use crate::model::track::Track;

/// A parsed query that can be reused while scoring a collection of tracks.
/// Spotify field filters, quoted phrases and boolean expressions are left to
/// Spotify rather than interpreted as an ordinary local music search.
pub struct SearchQuery {
    normalized: String,
    tokens: Vec<String>,
    structured: bool,
}

impl SearchQuery {
    pub fn new(query: &str) -> Self {
        let structured = query.contains([':', '"', '“', '”', '(', ')'])
            || query.contains("&&")
            || query.contains("||")
            || query
                .split_whitespace()
                .any(|word| matches!(word, "AND" | "OR" | "NOT"));
        let normalized = fold(query);
        let tokens = normalized.split_whitespace().map(str::to_owned).collect();
        Self {
            normalized,
            tokens,
            structured,
        }
    }

    pub fn is_structured(&self) -> bool {
        self.structured
    }

    /// Higher scores are better. Every query word must match a word in at least
    /// one field; word order does not matter. Whole words outrank prefixes, and
    /// prefixes outrank a single typo. Within those tiers, title hits lead.
    pub fn score(&self, title: &str, subtitle: &str, detail: &str) -> Option<u32> {
        if self.structured || self.tokens.is_empty() {
            return None;
        }
        let fields = [fold(title), fold(subtitle), fold(detail)];
        let words: Vec<_> = fields
            .iter()
            .enumerate()
            .flat_map(|(index, field)| {
                field
                    .split_whitespace()
                    .map(move |word| (word, 300 - index as u32 * 100))
            })
            .collect();
        let mut weakest = 3;
        let mut field_score = 0_u32;
        for token in &self.tokens {
            let (quality, field) = words
                .iter()
                .filter_map(|(word, field)| {
                    word_quality(token, word).map(|quality| (quality, *field))
                })
                .max()?;
            weakest = weakest.min(quality);
            field_score = field_score.saturating_add(field);
        }
        let title_bonus = if fields[0] == self.normalized {
            1000
        } else if fields[0].starts_with(&self.normalized) {
            500
        } else {
            0
        };
        Some(weakest * 10_000 + field_score / self.tokens.len() as u32 + title_bonus)
    }

    pub fn score_track(&self, track: &Track) -> Option<u32> {
        self.score(
            &track.title,
            &track.artists.join(" "),
            track.album.as_deref().unwrap_or_default(),
        )
    }
}

/// Decompose accents before dropping marks, retain letters/numbers from every
/// script, and treat punctuation as word boundaries. A few letters that do not
/// decompose get the same familiar folding as their Latin equivalents.
fn fold(text: &str) -> String {
    let mut folded = String::with_capacity(text.len());
    for character in text.nfkd().flat_map(char::to_lowercase) {
        if is_combining_mark(character) {
            continue;
        }
        match character {
            'ß' => folded.push_str("ss"),
            'æ' => folded.push_str("ae"),
            'œ' => folded.push_str("oe"),
            'ø' => folded.push('o'),
            'ł' => folded.push('l'),
            'đ' | 'ð' => folded.push('d'),
            'þ' => folded.push_str("th"),
            'ς' => folded.push('σ'),
            character if character.is_alphanumeric() => folded.push(character),
            _ => folded.push(' '),
        }
    }
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn word_quality(query: &str, word: &str) -> Option<u32> {
    if query == word {
        Some(3)
    } else if word.starts_with(query) {
        Some(2)
    } else if single_typo(query, word) {
        Some(1)
    } else {
        None
    }
}

/// Linear single-edit/transposition check. Restrict fuzzy work to ordinary word
/// lengths; long identifiers can still match exactly or by prefix.
fn single_typo(query: &str, word: &str) -> bool {
    const MAX_TYPO_CHARS: usize = 64;
    let query: Vec<_> = query.chars().take(MAX_TYPO_CHARS + 1).collect();
    if !(4..=MAX_TYPO_CHARS).contains(&query.len()) {
        return false;
    }
    let word: Vec<_> = word.chars().take(MAX_TYPO_CHARS + 1).collect();
    if !(4..=MAX_TYPO_CHARS).contains(&word.len()) || query.len().abs_diff(word.len()) > 1 {
        return false;
    }
    let Some(first) = query.iter().zip(&word).position(|(a, b)| a != b) else {
        return query.len().abs_diff(word.len()) == 1;
    };
    match query.len().cmp(&word.len()) {
        std::cmp::Ordering::Less => query[first..] == word[first + 1..],
        std::cmp::Ordering::Greater => query[first + 1..] == word[first..],
        std::cmp::Ordering::Equal => {
            query[first + 1..] == word[first + 1..]
                || (first + 1 < query.len()
                    && query[first] == word[first + 1]
                    && query[first + 1] == word[first]
                    && query[first + 2..] == word[first + 2..])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SearchQuery;

    #[test]
    fn tokens_match_in_any_order_across_music_fields() {
        let query = SearchQuery::new("reactor solaris bible");
        assert!(
            query
                .score("Solaris", "Juno Reactor", "Bible of Dreams")
                .is_some()
        );
        assert!(
            SearchQuery::new("reactor solaris missing")
                .score("Solaris", "Juno Reactor", "Bible of Dreams")
                .is_none()
        );
    }

    #[test]
    fn accents_case_and_punctuation_fold_consistently() {
        for query in [
            "beyonce deja vu",
            "BEYONCÉ DÉJÀ-VU",
            "Beyonce\u{301} de\u{301}ja\u{300} vu",
        ] {
            assert!(
                SearchQuery::new(query)
                    .score("Déjà Vu", "Beyoncé", "")
                    .is_some()
            );
        }
        assert!(
            SearchQuery::new("guns roses sweet child")
                .score("Sweet Child O’ Mine", "Guns N’ Roses", "")
                .is_some()
        );
        assert!(
            SearchQuery::new("strasse")
                .score("Straße", "", "")
                .is_some()
        );
    }

    #[test]
    fn prefixes_match_word_starts_without_short_substrings_or_typos() {
        assert!(
            SearchQuery::new("sol rea")
                .score("Solaris", "Juno Reactor", "")
                .is_some()
        );
        for query in ["ola", "uno", "slo", "cat"] {
            assert!(
                SearchQuery::new(query)
                    .score("Solaris", "Juno Reactor", "cut")
                    .is_none(),
                "{query}"
            );
        }
    }

    #[test]
    fn accepts_one_edit_or_transposition_but_rejects_multiple_edits() {
        for query in ["solairs", "solris", "solaaris", "solxris"] {
            assert!(
                SearchQuery::new(query).score("Solaris", "", "").is_some(),
                "{query}"
            );
        }
        assert!(
            SearchQuery::new("sxlarxs")
                .score("Solaris", "", "")
                .is_none()
        );
        let long = "a".repeat(256);
        assert!(SearchQuery::new(&long).score(&long, "", "").is_some());
        assert!(
            SearchQuery::new(&format!("{long}b"))
                .score(&long, "", "")
                .is_none()
        );
    }

    #[test]
    fn exact_and_title_hits_rank_before_prefixes_and_typos() {
        let query = SearchQuery::new("solaris");
        let title = query.score("Solaris", "", "").unwrap();
        let artist = query.score("Other", "Solaris", "").unwrap();
        let prefix = query.score("Solarisian", "", "").unwrap();
        let typo = query.score("Solairs", "", "").unwrap();
        assert!(title > artist && artist > prefix && prefix > typo);
    }

    #[test]
    fn structured_and_empty_queries_do_not_guess_locally() {
        for query in [
            "",
            "   ",
            "---",
            "artist:Beyoncé",
            "\"solar wind\"",
            "juno OR orbital",
            "juno AND reactor",
            "juno NOT reactor",
            "juno || orbital",
            "(juno)",
        ] {
            let parsed = SearchQuery::new(query);
            assert!(
                parsed
                    .score("Solar Wind", "Juno Reactor Beyoncé", "")
                    .is_none(),
                "{query}"
            );
        }
        assert!(SearchQuery::new("artist:juno").is_structured());
        assert!(!SearchQuery::new("Guns N’ Roses").is_structured());
    }
}
