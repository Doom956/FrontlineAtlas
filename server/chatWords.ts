// Words the chat filter masks with *** (server/chat.ts). Plain lowercase words: a word of a message is masked only
// when it is exactly one of these (after lowercasing, look-alike digits such as 0 for o, and letters repeated three
// or more times squeezed). There are no prefix or ending rules, so "assess", "class", "spices" and "Niger" pass:
// list every form you want masked. Leave out words with an everyday meaning (cock, dick, prick, hell, damn, crap, and
// chink, dyke and retard: a gap, an embankment and to slow down are likely words in a game about borders and rivers).
export const CHAT_BLOCKED_WORDS: readonly string[] = [
  // profanity
  'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'fuckin', 'fck', 'fuk', 'fukin', 'fking',
  'motherfucker', 'motherfuckers', 'motherfucking', 'mf', 'mfer', 'stfu', 'gtfo', 'shit', 'shits', 'shitty',
  'shithead', 'shitheads', 'bullshit', 'horseshit', 'bitch', 'bitches', 'bitchass', 'asshole', 'assholes', 'ass',
  'arse', 'arsehole', 'dumbass', 'jackass', 'cunt', 'cunts', 'twat', 'twats', 'wanker', 'wankers', 'bastard',
  'bastards', 'dickhead', 'dickheads', 'cocksucker', 'whore', 'whores', 'slut', 'sluts', 'porn', 'kys',
  // slurs
  'nigger', 'niggers', 'nigga', 'niggas', 'faggot', 'faggots', 'fag', 'fags', 'fagot', 'tranny',
  'trannies', 'retards', 'retarded', 'spic', 'spics', 'gook', 'gooks', 'kike', 'kikes',
  'wetback', 'wetbacks', 'beaner', 'beaners', 'coon', 'coons', 'raghead', 'ragheads', 'towelhead', 'towelheads',
  'paki', 'pakis',
];
