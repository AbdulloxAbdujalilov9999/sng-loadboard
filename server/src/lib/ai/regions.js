// Administrative regions (oblast / viloyat / krai / republic ...) people write INSTEAD of a city: "Xorazm",
// "Московская область", "Qashqadaryo viloyati". Each maps to the city that stands for that region on the board
// (normally its capital). Format per line:  COUNTRY | capital city (English) | region names, ";"-separated.
// The words "oblast / viloyat / region / область / вилоят ..." are ignored by the matcher, so list only the names.
// Capitals are looked up by NAME at start-up (not by a stored label), so a spelling difference in the city data
// cannot silently break a region.
const TABLE = `
UZ|Tashkent|Toshkent viloyati; Tashkent region; Ташкентская; Тошкент вилояти
UZ|Samarkand|Samarqand; Samarkandskaya; Самаркандская; Самарқанд вилояти
UZ|Bukhara|Buxoro; Bukharskaya; Бухарская; Бухоро вилояти
UZ|Navoi|Navoiy; Navoiyskaya; Навоийская; Навоий вилояти
UZ|Karshi|Qashqadaryo; Kashkadarya; Kashkadarinskaya; Кашкадарьинская; Қашқадарё
UZ|Termez|Surxondaryo; Surkhandarya; Surkhandarinskaya; Сурхандарьинская; Сурхондарё
UZ|Urgench|Xorazm; Khorezm; Khorazm; Khorezmskaya; Хорезмская; Хоразм
UZ|Nukus|Qoraqalpogiston; Qoraqalpog'iston; Karakalpakstan; Karakalpakiya; Республика Каракалпакстан; Каракалпакстан; Қорақалпоғистон
UZ|Andijan|Andijon; Andizhanskaya; Андижанская; Андижон вилояти
UZ|Fergana|Farg'ona; Fargona; Ferghana; Ферганская; Фарғона вилояти
UZ|Namangan|Namanganskaya; Наманганская; Наманган вилояти
UZ|Jizzakh|Jizzax; Dzhizakskaya; Джизакская; Жиззах вилояти
UZ|Gulistan|Sirdaryo; Syrdarya; Syrdaryinskaya; Сырдарьинская; Сирдарё
KZ|Kokshetau|Akmola; Akmolinskaya; Акмолинская
KZ|Aktobe|Aqtobe; Aktyubinskaya; Актюбинская
KZ|Taldykorgan|Almaty region; Almatinskaya; Алматинская; Jetisu; Zhetysu
KZ|Atyrau|Atyrauskaya; Атырауская
KZ|Ust-Kamenogorsk|East Kazakhstan; Vostochno-Kazakhstanskaya; Восточно-Казахстанская; VKO
KZ|Taraz|Zhambyl; Jambyl; Zhambylskaya; Жамбылская
KZ|Oral|West Kazakhstan; Zapadno-Kazakhstanskaya; Западно-Казахстанская; ZKO
KZ|Karaganda|Karagandinskaya; Карагандинская
KZ|Kostanay|Kostanayskaya; Костанайская
KZ|Kyzylorda|Kyzylordinskaya; Кызылординская
KZ|Aktau|Mangystau; Mangistau; Mangistauskaya; Мангистауская
KZ|Pavlodar|Pavlodarskaya; Павлодарская
KZ|Petropavl|North Kazakhstan; Severo-Kazakhstanskaya; Северо-Казахстанская; SKO
KZ|Turkistan|Turkestanskaya; Туркестанская; Yuzhno-Kazakhstanskaya; Южно-Казахстанская
KZ|Semey|Abai; Abay; Abaiskaya; Абайская
KZ|Zhezkazgan|Ulytau; Ulytauskaya; Улытауская
KG|Bishkek|Chuy; Chui; Chuyskaya; Чуйская
KG|Karakol|Issyk-Kul; Issyk Kul; Иссык-Кульская
KG|Naryn|Narynskaya; Нарынская
KG|Talas|Talasskaya; Таласская
KG|Osh|Oshskaya; Ошская
KG|Jalal-Abad|Dzhalal-Abadskaya; Джалал-Абадская
KG|Batken|Batkenskaya; Баткенская
TJ|Khujand|Sughd; Soghd; Sogd; Согдийская
TJ|Bokhtar|Khatlon; Khatlonskaya; Хатлонская
TJ|Khorugh|Badakhshan; GBAO; Gorno-Badakhshan; Горно-Бадахшанская
TJ|Dushanbe|Rasht; Nohiyahoi; RRS; Районы республиканского подчинения
TM|Ashgabat|Ahal; Akhal; Ahalskiy; Ахалский
TM|Turkmenbashi|Balkan; Balkanskiy; Балканский
TM|Dashoguz|Dasoguz; Dashoguzskiy; Дашогузский
TM|Turkmenabat|Lebap; Lebapskiy; Лебапский
TM|Mary|Maryiskiy; Марыйский
RU|Moscow|Moskovskaya; Московская; Подмосковье; Podmoskovye; Moscow region
RU|Saint Petersburg|Leningradskaya; Ленинградская; Leningrad region; Lenoblast; Ленобласть
RU|Belgorod|Belgorodskaya; Белгородская
RU|Bryansk|Bryanskaya; Брянская
RU|Vladimir|Vladimirskaya; Владимирская
RU|Voronezh|Voronezhskaya; Воронежская
RU|Ivanovo|Ivanovskaya; Ивановская
RU|Kaluga|Kaluzhskaya; Калужская
RU|Kostroma|Kostromskaya; Костромская
RU|Kursk|Kurskaya; Курская
RU|Lipetsk|Lipetskaya; Липецкая
RU|Oryol|Orlovskaya; Орловская; Orel
RU|Ryazan|Ryazanskaya; Рязанская
RU|Smolensk|Smolenskaya; Смоленская
RU|Tambov|Tambovskaya; Тамбовская
RU|Tver|Tverskaya; Тверская
RU|Tula|Tulskaya; Тульская
RU|Yaroslavl|Yaroslavskaya; Ярославская
RU|Arkhangelsk|Arkhangelskaya; Архангельская
RU|Vologda|Vologodskaya; Вологодская
RU|Kaliningrad|Kaliningradskaya; Калининградская
RU|Syktyvkar|Komi; Республика Коми; Коми
RU|Murmansk|Murmanskaya; Мурманская
RU|Veliky Novgorod|Novgorodskaya; Новгородская; Novgorod region
RU|Pskov|Pskovskaya; Псковская
RU|Petrozavodsk|Karelia; Karelskaya; Карелия; Республика Карелия
RU|Krasnodar|Krasnodarskiy; Краснодарский; Kuban; Кубань
RU|Astrakhan|Astrakhanskaya; Астраханская
RU|Volgograd|Volgogradskaya; Волгоградская
RU|Rostov-on-Don|Rostovskaya; Ростовская; Rostov region
RU|Makhachkala|Dagestan; Дагестан; Республика Дагестан
RU|Stavropol|Stavropolskiy; Ставропольский
RU|Nalchik|Kabardino-Balkaria; Кабардино-Балкария
RU|Grozny|Chechnya; Chechenskaya; Чечня; Чеченская
RU|Vladikavkaz|North Ossetia; Severnaya Osetiya; Северная Осетия; Alania
RU|Cheboksary|Chuvashia; Chuvashskaya; Чувашия; Чувашская
RU|Kazan|Tatarstan; Республика Татарстан; Татарстан
RU|Yoshkar-Ola|Mari El; Марий Эл
RU|Saransk|Mordovia; Mordoviya; Мордовия
RU|Izhevsk|Udmurtia; Udmurtiya; Удмуртия
RU|Nizhny Novgorod|Nizhegorodskaya; Нижегородская
RU|Kirov|Kirovskaya; Кировская
RU|Penza|Penzenskaya; Пензенская
RU|Samara|Samarskaya; Самарская
RU|Saratov|Saratovskaya; Саратовская
RU|Ulyanovsk|Ulyanovskaya; Ульяновская
RU|Ufa|Bashkortostan; Bashkiria; Башкортостан; Башкирия
RU|Orenburg|Orenburgskaya; Оренбургская
RU|Perm|Permskiy; Пермский; Prikamye
RU|Yekaterinburg|Sverdlovskaya; Свердловская; Ural
RU|Chelyabinsk|Chelyabinskaya; Челябинская
RU|Kurgan|Kurganskaya; Курганская
RU|Tyumen|Tyumenskaya; Тюменская
RU|Surgut|Khanty-Mansi; KhMAO; Ханты-Мансийский; ХМАО; Югра; Yugra
RU|Novosibirsk|Novosibirskaya; Новосибирская
RU|Omsk|Omskaya; Омская
RU|Tomsk|Tomskaya; Томская
RU|Kemerovo|Kuzbass; Kemerovskaya; Кемеровская; Кузбасс
RU|Barnaul|Altaiskiy; Алтайский; Altai Krai; Altay
RU|Krasnoyarsk|Krasnoyarskiy; Красноярский
RU|Irkutsk|Irkutskaya; Иркутская
RU|Ulan-Ude|Buryatia; Buryatiya; Бурятия
RU|Chita|Zabaikalsky; Zabaykalsky; Забайкальский
RU|Yakutsk|Sakha; Yakutia; Саха; Якутия
RU|Khabarovsk|Khabarovskiy; Хабаровский
RU|Vladivostok|Primorskiy; Primorye; Приморский; Приморье
RU|Abakan|Khakassia; Khakasiya; Хакасия
RU|Kyzyl|Tuva; Tyva; Тыва; Тува
RU|Elista|Kalmykia; Kalmykiya; Калмыкия
RU|Maykop|Adygea; Adygeya; Адыгея
RU|Cherkessk|Karachay-Cherkessia; Карачаево-Черкесия
RU|Nazran|Ingushetia; Ингушетия
`;

export const REGION_ROWS = TABLE.trim().split('\n').map((line) => {
  const [country, capital, names] = line.split('|');
  return { country: country.trim(), capital: capital.trim(), names: names.split(';').map((s) => s.trim()).filter(Boolean) };
});

// Words that only say "this is an administrative area / a city" - never part of a place name.
export const NOISE_WORDS = new Set([
  'oblast', 'obl', 'oblasti', 'oblysy', 'region', 'viloyat', 'viloyati', 'vilojat', 'vil', 'tuman', 'tumani', 'rayon', 'raion', 'district',
  'krai', 'kray', 'respublika', 'republic', 'gorod', 'city', 'shahar', 'shahri', 'sh', 'g', 'gor', 'province', 'prov', 'oblasty',
  'область', 'обл', 'вилоят', 'вилояти', 'район', 'республика', 'край', 'город', 'гор', 'г', 'шахри', 'туман', 'тумани',
  'from', 'to', 'iz', 'v', 'na', 'в', 'из', 'на', 'до', 'the', 'and', 'i', 'и',
]);
