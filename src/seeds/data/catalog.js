/**
 * Real books with genuine ISBNs, so the check-digit validation is exercised by
 * the seed rather than merely by hand-written tests — if the ISBN logic were
 * wrong, seeding would fail loudly.
 */

export const authors = [
  { name: 'Chinua Achebe', nationality: 'Nigerian', birthYear: 1930, deathYear: 2013, bio: 'Novelist, poet and critic, widely regarded as a central figure of modern African literature.' },
  { name: 'Ursula K. Le Guin', nationality: 'American', birthYear: 1929, deathYear: 2018, bio: 'Author of speculative fiction whose work explores anarchism, Taoism and gender.' },
  { name: 'Thomas H. Cormen', nationality: 'American', birthYear: 1956, bio: 'Computer scientist and co-author of the standard text on algorithms.' },
  { name: 'Charles E. Leiserson', nationality: 'American', birthYear: 1953, bio: 'Computer scientist specialising in parallel computing.' },
  { name: 'Robert C. Martin', nationality: 'American', birthYear: 1952, bio: 'Software engineer and author, known for writing on craftsmanship and design.' },
  { name: 'Yuval Noah Harari', nationality: 'Israeli', birthYear: 1976, bio: 'Historian and author of works on the long arc of human development.' },
  { name: 'Arundhati Roy', nationality: 'Indian', birthYear: 1961, bio: 'Novelist and essayist; won the Booker Prize for her debut novel.' },
  { name: 'R. K. Narayan', nationality: 'Indian', birthYear: 1906, deathYear: 2001, bio: 'One of the leading figures of early Indian literature in English.' },
  { name: 'Carl Sagan', nationality: 'American', birthYear: 1934, deathYear: 1996, bio: 'Astronomer and science communicator.' },
  { name: 'Stuart Russell', nationality: 'British', birthYear: 1962, bio: 'Computer scientist and co-author of the standard text on artificial intelligence.' },
  { name: 'Peter Norvig', nationality: 'American', birthYear: 1956, bio: 'Computer scientist working in artificial intelligence.' },
  { name: 'Toni Morrison', nationality: 'American', birthYear: 1931, deathYear: 2019, bio: 'Novelist and Nobel laureate.' },
  { name: 'Haruki Murakami', nationality: 'Japanese', birthYear: 1949, bio: 'Novelist whose work blends realism with the surreal.' },
  { name: 'Donald E. Knuth', nationality: 'American', birthYear: 1938, bio: 'Computer scientist, author of The Art of Computer Programming.' },
  { name: 'Michelle Obama', nationality: 'American', birthYear: 1964, bio: 'Lawyer, author and former First Lady of the United States.' },
  { name: 'Amitav Ghosh', nationality: 'Indian', birthYear: 1956, bio: 'Novelist writing on history, migration and climate.' },
];

export const publishers = [
  { name: 'Penguin Books', foundedYear: 1935, website: 'https://www.penguin.co.uk', address: { city: 'London', country: 'United Kingdom' } },
  { name: 'MIT Press', foundedYear: 1962, website: 'https://mitpress.mit.edu', address: { city: 'Cambridge', country: 'United States' } },
  { name: 'Oxford University Press', foundedYear: 1586, website: 'https://global.oup.com', address: { city: 'Oxford', country: 'United Kingdom' } },
  { name: 'HarperCollins', foundedYear: 1989, website: 'https://www.harpercollins.com', address: { city: 'New York', country: 'United States' } },
  { name: 'Prentice Hall', foundedYear: 1913, address: { city: 'New Jersey', country: 'United States' } },
  { name: 'Rupa Publications', foundedYear: 1936, address: { city: 'New Delhi', country: 'India' } },
];

/**
 * The category tree, as a nested structure. The seeder walks it depth-first and
 * lets the model compute each node's ancestor path.
 */
export const categoryTree = [
  {
    name: 'Fiction',
    icon: 'book-open',
    color: '#8b5cf6',
    children: [
      { name: 'Literary Fiction' },
      { name: 'Science Fiction' },
      { name: 'Historical Fiction' },
      { name: 'Indian Writing in English' },
    ],
  },
  {
    name: 'Science',
    icon: 'flask',
    color: '#06b6d4',
    children: [
      {
        name: 'Computer Science',
        children: [
          { name: 'Algorithms' },
          { name: 'Artificial Intelligence' },
          { name: 'Software Engineering' },
        ],
      },
      { name: 'Astronomy' },
      { name: 'Physics' },
    ],
  },
  {
    name: 'Non-Fiction',
    icon: 'newspaper',
    color: '#f59e0b',
    children: [{ name: 'History' }, { name: 'Biography & Memoir' }, { name: 'Essays' }],
  },
];

/**
 * Books.
 */
export const books = [
  {
    title: 'Things Fall Apart',
    isbn13: '9780385474542',
    authorNames: ['Chinua Achebe'],
    publisherName: 'Penguin Books',
    categoryNames: ['Literary Fiction'],
    publishedYear: 1958,
    pageCount: 209,
    language: 'en',
    price: 399,
    tags: ['classic', 'africa', 'colonialism'],
    description:
      'Okonkwo is a wealthy and respected warrior of the Umuofia clan, a lower Nigerian tribe that is part of a consortium of nine connected villages. He is haunted by the actions of his father, a lazy and cowardly man who died in disrepute. The novel traces the collision between traditional Igbo society and the arrival of European missionaries and colonial administration.',
    copies: 4,
  },
  {
    title: 'The Left Hand of Darkness',
    isbn13: '9780441478125',
    authorNames: ['Ursula K. Le Guin'],
    publisherName: 'Penguin Books',
    categoryNames: ['Science Fiction'],
    publishedYear: 1969,
    pageCount: 304,
    price: 499,
    tags: ['scifi', 'gender', 'classic'],
    description:
      'Genly Ai is an emissary sent to the frozen planet of Gethen, whose inhabitants are ambisexual, adopting a gender only during a monthly period of fertility. His mission to bring Gethen into an interstellar federation is complicated by political intrigue and by his own inability to understand a society without fixed gender.',
    copies: 2,
  },
  {
    title: 'Introduction to Algorithms',
    subtitle: 'Fourth Edition',
    isbn13: '9780262046305',
    authorNames: ['Thomas H. Cormen', 'Charles E. Leiserson'],
    publisherName: 'MIT Press',
    categoryNames: ['Algorithms'],
    publishedYear: 2022,
    pageCount: 1312,
    edition: '4th',
    price: 1899,
    tags: ['textbook', 'algorithms', 'reference'],
    description:
      'A comprehensive introduction to the modern study of computer algorithms, covering a broad range of algorithms in depth while making their design and analysis accessible to all levels of reader. Each chapter is relatively self-contained and presents an algorithm, a design technique, an application area, or a related topic.',
    copies: 6,
  },
  {
    title: 'Clean Code',
    subtitle: 'A Handbook of Agile Software Craftsmanship',
    isbn13: '9780132350884',
    authorNames: ['Robert C. Martin'],
    publisherName: 'Prentice Hall',
    categoryNames: ['Software Engineering'],
    publishedYear: 2008,
    pageCount: 464,
    price: 899,
    tags: ['programming', 'craftsmanship', 'textbook'],
    description:
      'Even bad code can function, but if code is not clean it can bring a development organisation to its knees. This book presents a set of practices for writing readable, maintainable software, illustrated with case studies of progressively refactoring real code.',
    copies: 3,
  },
  {
    title: 'Artificial Intelligence',
    subtitle: 'A Modern Approach',
    isbn13: '9780134610993',
    authorNames: ['Stuart Russell', 'Peter Norvig'],
    publisherName: 'Prentice Hall',
    categoryNames: ['Artificial Intelligence'],
    publishedYear: 2020,
    pageCount: 1136,
    edition: '4th',
    price: 2199,
    tags: ['textbook', 'ai', 'reference'],
    description:
      'The standard text in artificial intelligence, covering search, knowledge representation, planning, probabilistic reasoning, machine learning, perception and robotics, with an extended treatment of the ethical and safety implications of increasingly capable systems.',
    // Deliberately ONE copy: gives the concurrency test something to contend over.
    copies: 1,
  },
  {
    title: 'Sapiens',
    subtitle: 'A Brief History of Humankind',
    isbn13: '9780062316097',
    authorNames: ['Yuval Noah Harari'],
    publisherName: 'HarperCollins',
    categoryNames: ['History'],
    publishedYear: 2015,
    pageCount: 464,
    price: 599,
    tags: ['history', 'anthropology', 'bestseller'],
    description:
      'A survey of the history of our species from the emergence of Homo sapiens in the Stone Age to the political and technological revolutions of the twenty-first century, organised around the cognitive, agricultural and scientific revolutions.',
    copies: 5,
  },
  {
    title: 'The God of Small Things',
    isbn13: '9780679457312',
    authorNames: ['Arundhati Roy'],
    publisherName: 'Penguin Books',
    categoryNames: ['Indian Writing in English', 'Literary Fiction'],
    publishedYear: 1997,
    pageCount: 340,
    price: 450,
    tags: ['booker-prize', 'india', 'family'],
    description:
      'Set in Kerala, the novel tells the story of fraternal twins Rahel and Estha, whose lives are destroyed by the Love Laws that lay down who should be loved, and how, and how much. The narrative moves between 1969 and 1993, circling the events of a single catastrophic day.',
    copies: 3,
  },
  {
    title: 'The Guide',
    isbn13: '9780143039648',
    authorNames: ['R. K. Narayan'],
    publisherName: 'Penguin Books',
    categoryNames: ['Indian Writing in English'],
    publishedYear: 1958,
    pageCount: 220,
    price: 299,
    tags: ['india', 'classic', 'malgudi'],
    description:
      'Raju, a corrupt tourist guide recently released from prison, is mistaken for a holy man by the villagers of Mangala. As their faith in him grows, he finds himself drawn into a role he never sought, culminating in a fast he cannot escape.',
    copies: 2,
  },
  {
    title: 'Cosmos',
    isbn13: '9780345539434',
    authorNames: ['Carl Sagan'],
    publisherName: 'Penguin Books',
    categoryNames: ['Astronomy'],
    publishedYear: 1980,
    pageCount: 396,
    price: 699,
    tags: ['science', 'astronomy', 'popular-science'],
    description:
      'A tour of the universe and of the history of scientific thought, from the library of Alexandria to the exploration of the outer planets, arguing throughout that science is a way of thinking rather than a body of facts.',
    copies: 3,
  },
  {
    title: 'Beloved',
    isbn13: '9781400033416',
    authorNames: ['Toni Morrison'],
    publisherName: 'Penguin Books',
    categoryNames: ['Literary Fiction', 'Historical Fiction'],
    publishedYear: 1987,
    pageCount: 324,
    price: 520,
    tags: ['pulitzer', 'classic', 'slavery'],
    description:
      'Sethe, born a slave and escaped to Ohio, remains haunted eighteen years later by the memory of what she did to secure her freedom, and by the arrival of a young woman who calls herself Beloved.',
    copies: 2,
  },
  {
    title: 'Norwegian Wood',
    isbn13: '9780375704024',
    authorNames: ['Haruki Murakami'],
    publisherName: 'Penguin Books',
    categoryNames: ['Literary Fiction'],
    publishedYear: 1987,
    pageCount: 296,
    price: 480,
    tags: ['japan', 'coming-of-age'],
    description:
      'Toru Watanabe recalls his student years in 1960s Tokyo, and his relationships with two very different women, against a backdrop of loss and the difficulty of moving forward from it.',
    copies: 2,
  },
  {
    title: 'The Art of Computer Programming, Volume 1',
    subtitle: 'Fundamental Algorithms',
    isbn13: '9780201896831',
    authorNames: ['Donald E. Knuth'],
    publisherName: 'Prentice Hall',
    categoryNames: ['Algorithms'],
    publishedYear: 1997,
    pageCount: 650,
    edition: '3rd',
    price: 3499,
    tags: ['reference', 'algorithms', 'classic'],
    description:
      'The first volume of the definitive treatise on computer programming, covering basic concepts, information structures, and the mathematical preliminaries needed to analyse algorithms rigorously.',
    // No copies at all — makes NO_COPY_AVAILABLE reachable without borrowing first.
    copies: 0,
  },
  {
    title: 'Becoming',
    isbn13: '9781524763138',
    authorNames: ['Michelle Obama'],
    publisherName: 'HarperCollins',
    categoryNames: ['Biography & Memoir'],
    publishedYear: 2018,
    pageCount: 448,
    price: 799,
    tags: ['memoir', 'bestseller'],
    description:
      'A memoir tracing the author’s childhood on the South Side of Chicago, her years balancing work and motherhood, and her time at the most famous address in the world.',
    copies: 4,
  },
  {
    title: 'The Shadow Lines',
    isbn13: '9780618329960',
    authorNames: ['Amitav Ghosh'],
    publisherName: 'Rupa Publications',
    categoryNames: ['Indian Writing in English', 'Historical Fiction'],
    publishedYear: 1988,
    pageCount: 246,
    price: 350,
    tags: ['india', 'partition', 'memory'],
    description:
      'Moving between Calcutta, Dhaka and London, the novel examines how the lines drawn on maps shape and distort the memories of those who live across them.',
    copies: 2,
  },
  {
    title: 'A Wizard of Earthsea',
    isbn13: '9780553383041',
    authorNames: ['Ursula K. Le Guin'],
    publisherName: 'Penguin Books',
    categoryNames: ['Science Fiction'],
    publishedYear: 1968,
    pageCount: 183,
    price: 420,
    tags: ['fantasy', 'classic', 'coming-of-age'],
    description:
      'A young man with a gift for magic is sent to a school for wizards, where his pride looses a shadow into the world that he must eventually turn and face.',
    copies: 3,
  },
];

export default { authors, publishers, categoryTree, books };
