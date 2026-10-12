// Bot translations: English, Russian, Uzbek - the same three languages sng-loadboard and
// sng-loadboard-bot offer. Flat dictionaries, `t(lang, key, vars)` with {placeholder}
// substitution, falling back to English and then to the key itself so a missing translation
// never crashes a chat.

export const LANGS = ['en', 'ru', 'uz'];
export const DEFAULT_LANG = 'uz';
const FALLBACK_LANG = 'en';

export const LANG_NAMES = { en: 'English', ru: 'Русский', uz: 'Oʻzbekcha' };

const DICT = {
  en: {
    welcome: "Welcome to the SNG ONE AI load importer.\n\n"
      + "Paste or forward any freight post here - one load or many, Russian or Uzbek, any layout - "
      + "and I'll split it into drafts with the same AI the website's \"paste from Telegram\" screen "
      + "uses, show you each one, and post them all to the loadboard the moment you tap Post.\n\n"
      + "• /link - connect your SNG ONE account with your phone number and PIN (DM only, required before posting)\n"
      + "• /myloads - list and delete your own loads\n"
      + "• /mystatus - check your link\n"
      + "• /unlink - disconnect your account\n"
      + "• /language - change this bot's language",
    language_prompt: 'Choose a language:',
    language_set: 'Language set to English.',
    generic_error: 'Something went wrong - please try again.',
    busy_finish_or_cancel: 'Finish this step, or send /cancel to stop.',

    status_pending: 'pending',
    status_approved: 'active',
    status_rejected: 'blocked',

    eq_T: 'Tent/Tilt', eq_R: 'Refrigerated', eq_F: 'Flatbed', eq_V: 'Box/Dry Van', eq_AC: 'Auto Carrier',
    fp_full: 'Full', fp_partial: 'Partial', negotiable: 'Negotiable',

    flag_origin: 'origin city not recognized',
    flag_dest: 'destination city not recognized',
    flag_same_city: 'origin and destination look the same',
    flag_origin_check: 'origin city is a guess - please verify',
    flag_dest_check: 'destination city is a guess - please verify',
    flag_weight: 'weight was not stated - defaulted to 20t',
    flag_date: 'pickup date was not stated or already passed - defaulted to today',
    flag_rate: 'rate was not stated - posted as negotiable',

    fb_email_not_found: 'No account with that e-mail. Sign up on the web app first, or check the spelling.',
    fb_invalid_password: 'Wrong password.',
    fb_invalid_login_credentials: 'Wrong e-mail or password. (No password because you sign in with Google or a phone? Set one on the website first: Account → Sign-in & Security.)',
    fb_user_disabled: 'This account has been disabled.',
    fb_token_expired: 'Your session expired - please /link again.',
    fb_user_not_found: 'This account no longer exists - please /link again.',
    fb_generic: 'Sign-in failed ({code}).',

    link_dm_only: "To keep your PIN private, DM me to link your account (tap my name, then Message).",
    link_usage: "Send /link and then your phone number and your PIN (4-6 digits).\nOr in one message: /link +998901234567 482915\n\nNo account yet? Create one on the SNG ONE website with your phone number first, then come back. (Signed up with an e-mail? Use /linkemail your@email.com password.)",
    link_email_usage: "Usage: /linkemail your@email.com yourPassword\n\n(The e-mail + password you use to sign in on the website. Signed in with a phone? Use /link instead.)",
    link_ask_phone: "Send the phone number of your SNG ONE account, or tap the button to share your Telegram number. (/cancel to stop)",
    link_share_phone: "📱 Share my number",
    link_contact_not_yours: "That is not your own number. Type the phone number of your SNG ONE account.",
    link_bad_phone: "That does not look like a phone number. Send it with the country code, e.g. +998901234567.",
    link_ask_pin: "Now send your PIN (4-6 digits). I delete your message right away.",
    link_bad_pin: "The PIN is 4 to 6 digits. Try again, or /cancel.",
    link_pin_wrong: "Wrong phone number or PIN. Try again, or /cancel.\n\nForgot it? Ask the platform owner to reset your password.",
    link_pin_wrong_final: "Wrong phone number or PIN. Send /link to start again.",
    link_pin_locked: "Too many wrong tries. Try again in {min} min, or ask the platform owner to reset it.",
    link_blocked: "This account is blocked. Please contact the platform owner.",
    link_cancelled: "Cancelled.",
    link_unreachable: 'Could not reach the loadboard right now - please try again in a moment.',
    link_unverified: 'Your e-mail is not confirmed yet. Open the confirmation link we e-mailed you (check Spam), then /link again.',
    link_no_account: "No SNG ONE account for that number. Sign up on the website first, then /link again.",
    link_not_approved: "This account cannot be linked right now (status: {status}).",
    link_success: 'Linked as {company} ✅\n\nNow just paste a freight post and I\'ll turn it into loads.',
    unlink_done: 'Unlinked. Your Telegram account no longer posts as any loadboard member.',
    unlink_none: 'You were not linked.',
    mystatus_none: "Not linked. Send /link (in DM).",
    mystatus_linked: "Linked as {company} ({login}) - status: {status}.",

    myloads_dm_only: 'DM me and send /myloads there.',
    myloads_empty: "You haven't posted any loads yet.",
    myloads_header: 'Your loads ({count}):',
    myloads_btn_delete: '🗑 Delete',
    myloads_confirm: 'Delete this load from the board and every chat it reached?',
    myloads_btn_yes: 'Yes, delete',
    myloads_btn_no: 'No',
    myloads_cancelled: 'Kept - not deleted.',
    myloads_deleted: '✅ Deleted.',
    myloads_delete_failed: 'Could not delete - please try again later.',

    paste_dm_only: 'DM me (tap my name, then Message) and paste it there - posting may include your contact details.',
    paste_not_linked: "Not linked yet. Send /link first, then paste your text again.",
    paste_session_error: "Your session ended (e.g. the PIN was changed) - please /link again, then paste your text again.",
    paste_not_approved: 'Your account is not approved to post right now.',
    paste_unreachable: 'Could not reach the loadboard right now - please try again in a moment.',
    paste_parsing: '🤖 Reading that text…',
    paste_ai_unavailable: 'AI import is not set up on the server yet - ask the platform owner to set GEMINI_API_KEY.',
    paste_ai_busy: 'The AI import is busy or you\'ve hit your hourly limit - please try again in a bit.',
    paste_bad_output: 'The AI answered in an unexpected format - please try again.',
    paste_no_loads_found: "I didn't find any loads in that text. Paste a freight post (route, truck type, cargo, dates) and I'll split it up.",
    paste_truncated_note: '(only the first {max} loads in that text were read - paste the rest separately)',
    paste_found_header: '📦 Found {count} load(s) in that text:',
    paste_skip_note: '\n🚫 {count} will be skipped - the city couldn\'t be matched. Fix the wording and paste that one again.',
    paste_ready_footer: '\nReady to post {postable} of {total}.',
    paste_btn_post: '✅ Post {count} load(s)',
    paste_btn_cancel: '❌ Cancel',
    paste_cancelled: 'Cancelled - nothing was posted.',
    paste_expired: 'This batch expired - please paste the text again.',
    paste_nothing_postable: 'None of these could be posted (no city matched) - fix the wording and paste again.',
    paste_posted_header: '✅ Posted {count} load{plural} - live on the loadboard now:',
    paste_post_failed: 'Could not post: {message}',
    paste_post_failed_generic: 'Could not post - please try again later.',
    paste_subscription_required: "Your free trial or subscription has ended, so posting is closed. Pay and the platform owner reopens it - see the website, Account & Settings.",
    paste_contact_missing: "Your profile has no phone number or Telegram username, and this text didn't carry one either, so these loads have nothing to show as contact info. Add a phone or Telegram in your profile on the website, then paste again.",
  },

  ru: {
    welcome: 'Добро пожаловать в AI-импорт грузов SNG ONE.\n\n'
      + 'Вставьте или перешлите сюда любой пост о грузе - один или несколько, на русском или '
      + 'узбекском, в любом формате - и я разберу его на черновики тем же AI, который использует '
      + 'раздел «вставить из Telegram» на сайте, покажу каждый груз и опубликую все на бирже, как '
      + 'только вы нажмёте «Опубликовать».\n\n'
      + '• /link - привязать аккаунт SNG ONE по номеру телефона и PIN-коду (только в личных сообщениях, обязательно перед публикацией)\n'
      + '• /myloads - список и удаление ваших грузов\n'
      + '• /mystatus - проверить привязку аккаунта\n'
      + '• /unlink - отвязать аккаунт\n'
      + '• /language - сменить язык бота',
    language_prompt: 'Выберите язык:',
    language_set: 'Установлен русский язык.',
    generic_error: 'Что-то пошло не так - попробуйте ещё раз.',
    busy_finish_or_cancel: 'Завершите этот шаг или отправьте /cancel, чтобы остановиться.',

    status_pending: 'на рассмотрении',
    status_approved: 'активен',
    status_rejected: 'заблокирован',

    eq_T: 'Тент', eq_R: 'Рефрижератор', eq_F: 'Открытый/Шаланда', eq_V: 'Фургон', eq_AC: 'Автовоз',
    fp_full: 'Полная', fp_partial: 'Частичная', negotiable: 'Договорная',

    flag_origin: 'город отправления не распознан',
    flag_dest: 'город назначения не распознан',
    flag_same_city: 'отправление и назначение похожи на один и тот же город',
    flag_origin_check: 'город отправления определён предположительно - проверьте',
    flag_dest_check: 'город назначения определён предположительно - проверьте',
    flag_weight: 'вес не указан - поставлено 20т по умолчанию',
    flag_date: 'дата погрузки не указана или уже прошла - поставлена сегодняшняя',
    flag_rate: 'ставка не указана - опубликовано как «договорная»',

    fb_email_not_found: 'Аккаунт с таким e-mail не найден. Сначала зарегистрируйтесь на сайте или проверьте написание.',
    fb_invalid_password: 'Неверный пароль.',
    fb_invalid_login_credentials: 'Неверный e-mail или пароль. (Нет пароля, потому что входите через Google или телефон? Сначала задайте его на сайте: Аккаунт → Вход и безопасность.)',
    fb_user_disabled: 'Этот аккаунт отключён.',
    fb_token_expired: 'Сессия истекла - выполните /link ещё раз.',
    fb_user_not_found: 'Этот аккаунт больше не существует - выполните /link ещё раз.',
    fb_generic: 'Не удалось войти ({code}).',

    link_dm_only: "Чтобы ваш PIN остался в тайне, напишите мне в личные сообщения (нажмите на моё имя, затем «Написать»).",
    link_usage: "Отправьте /link, затем номер телефона и PIN-код (4-6 цифр).\nИли одним сообщением: /link +998901234567 482915\n\nЕщё нет аккаунта? Сначала создайте его на сайте SNG ONE по номеру телефона и вернитесь. (Регистрировались по e-mail? Используйте /linkemail your@email.com пароль.)",
    link_email_usage: "Использование: /linkemail your@email.com пароль\n\n(E-mail и пароль, с которыми вы входите на сайте. Входите по телефону? Используйте /link.)",
    link_ask_phone: "Отправьте номер телефона вашего аккаунта SNG ONE или нажмите кнопку, чтобы поделиться номером из Telegram. (/cancel — отмена)",
    link_share_phone: "📱 Поделиться номером",
    link_contact_not_yours: "Это не ваш номер. Введите номер телефона вашего аккаунта SNG ONE.",
    link_bad_phone: "Это не похоже на номер телефона. Отправьте его с кодом страны, например +998901234567.",
    link_ask_pin: "Теперь отправьте ваш PIN-код (4-6 цифр). Я сразу удалю это сообщение.",
    link_bad_pin: "PIN состоит из 4-6 цифр. Попробуйте ещё раз или /cancel.",
    link_pin_wrong: "Неверный номер или PIN. Попробуйте ещё раз или /cancel.\n\nЗабыли? Попросите владельца платформы сбросить пароль.",
    link_pin_wrong_final: "Неверный номер или PIN. Отправьте /link, чтобы начать заново.",
    link_pin_locked: "Слишком много неверных попыток. Повторите через {min} мин. или попросите владельца сбросить пароль.",
    link_blocked: "Этот аккаунт заблокирован. Свяжитесь с владельцем платформы.",
    link_cancelled: "Отменено.",
    link_unreachable: 'Не удаётся подключиться к бирже прямо сейчас - попробуйте через минуту.',
    link_unverified: 'Ваш e-mail ещё не подтверждён. Откройте ссылку подтверждения из письма (проверьте «Спам»), затем снова /link.',
    link_no_account: "Для этого номера нет аккаунта SNG ONE. Сначала зарегистрируйтесь на сайте, затем снова /link.",
    link_not_approved: "Этот аккаунт сейчас нельзя привязать (статус: {status}).",
    link_success: 'Вы привязаны как {company} ✅\n\nТеперь просто вставьте пост о грузе, и я превращу его в объявления.',
    unlink_done: 'Отвязано. Ваш Telegram-аккаунт больше не публикует от имени какого-либо участника биржи.',
    unlink_none: 'Вы не были привязаны.',
    mystatus_none: "Не привязано. Отправьте /link (в личных сообщениях).",
    mystatus_linked: "Вы привязаны как {company} ({login}) - статус: {status}.",

    myloads_dm_only: 'Напишите мне в личные сообщения и отправьте /myloads там.',
    myloads_empty: 'Вы пока не разместили ни одного груза.',
    myloads_header: 'Ваши грузы ({count}):',
    myloads_btn_delete: '🗑 Удалить',
    myloads_confirm: 'Удалить этот груз с биржи и из всех чатов, куда он попал?',
    myloads_btn_yes: 'Да, удалить',
    myloads_btn_no: 'Нет',
    myloads_cancelled: 'Оставлено - не удалено.',
    myloads_deleted: '✅ Удалено.',
    myloads_delete_failed: 'Не удалось удалить - попробуйте позже.',

    paste_dm_only: 'Напишите мне в личные сообщения (нажмите на моё имя, затем «Написать») и вставьте текст там - при публикации могут потребоваться ваши контактные данные.',
    paste_not_linked: "Аккаунт ещё не привязан. Сначала отправьте /link, затем вставьте текст снова.",
    paste_session_error: "Сессия завершена (например, сменили PIN) - выполните /link ещё раз, затем вставьте текст снова.",
    paste_not_approved: 'Сейчас ваш аккаунт не одобрен для размещения грузов.',
    paste_unreachable: 'Не удаётся подключиться к бирже прямо сейчас - попробуйте через минуту.',
    paste_parsing: '🤖 Читаю текст…',
    paste_ai_unavailable: 'AI-импорт пока не настроен на сервере - попросите владельца платформы задать GEMINI_API_KEY.',
    paste_ai_busy: 'AI-импорт сейчас занят, либо вы достигли часового лимита - попробуйте немного позже.',
    paste_bad_output: 'AI ответил в неожиданном формате - попробуйте ещё раз.',
    paste_no_loads_found: "Я не нашёл грузов в этом тексте. Вставьте пост о грузе (маршрут, тип машины, груз, даты), и я разберу его.",
    paste_truncated_note: '(прочитаны только первые {max} грузов из текста - остальное вставьте отдельно)',
    paste_found_header: '📦 Найдено {count} груз(ов) в этом тексте:',
    paste_skip_note: '\n🚫 {count} будет пропущено - город не распознан. Исправьте написание и вставьте этот груз заново.',
    paste_ready_footer: '\nГотово к публикации: {postable} из {total}.',
    paste_btn_post: '✅ Опубликовать {count} груз(ов)',
    paste_btn_cancel: '❌ Отмена',
    paste_cancelled: 'Отменено - ничего не опубликовано.',
    paste_expired: 'Эта подборка устарела - вставьте текст снова.',
    paste_nothing_postable: 'Ни один из этих грузов нельзя опубликовать (город не распознан) - исправьте написание и вставьте снова.',
    paste_posted_header: '✅ Опубликовано {count} груз{plural} - уже на бирже:',
    paste_post_failed: 'Не удалось опубликовать: {message}',
    paste_post_failed_generic: 'Не удалось опубликовать - попробуйте позже.',
    paste_subscription_required: "Пробный период или подписка закончились, поэтому публикация закрыта. Оплатите, и владелец платформы откроет доступ - подробности на сайте, «Аккаунт и настройки».",
    paste_contact_missing: "В вашем профиле нет телефона или Telegram, и в этом тексте их тоже нет, так что показать контакт для этих грузов нечем. Добавьте телефон или Telegram в профиле на сайте и вставьте текст снова.",
  },

  uz: {
    welcome: "SNG ONE AI yuk import botiga xush kelibsiz.\n\n"
      + "Shu yerga istalgan yuk postini joylang yoki forward qiling - bitta yoki bir nechta, "
      + "ruscha yoki o'zbekcha, qanday formatda bo'lsa ham - saytdagi \"Telegramdan joylash\" "
      + "boʻlimi ishlatadigan AI bilan ularni alohida qoralamalarga ajrataman, har birini "
      + "ko'rsataman va «Joylash» tugmasini bosishingiz bilan barchasini birjaga joylayman.\n\n"
      + "• /link - SNG ONE hisobingizni telefon raqami va PIN bilan ulash (faqat shaxsiy xabarda, joylashdan oldin kerak)\n"
      + "• /myloads - yuklaringiz roʻyxati va oʻchirish\n"
      + "• /mystatus - ulanishni tekshirish\n"
      + "• /unlink - hisobni uzish\n"
      + "• /language - bot tilini oʻzgartirish",
    language_prompt: 'Tilni tanlang:',
    language_set: "Til oʻzbekchaga oʻrnatildi.",
    generic_error: 'Nimadir xato ketdi - qayta urinib koʻring.',
    busy_finish_or_cancel: "Avval shu bosqichni tugating yoki toʻxtatish uchun /cancel yuboring.",

    status_pending: "koʻrib chiqilmoqda",
    status_approved: "faol",
    status_rejected: "bloklangan",

    eq_T: 'Tent (Shtorali)', eq_R: 'Refrijerator', eq_F: 'Ochiq (Flatbed)', eq_V: 'Furgon', eq_AC: 'Avtovoz',
    fp_full: "Toʻliq", fp_partial: 'Qisman', negotiable: 'Kelishilgan',

    flag_origin: "jo'natish shahri aniqlanmadi",
    flag_dest: "manzil shahri aniqlanmadi",
    flag_same_city: "jo'natish va manzil bir xil shaharga o'xshaydi",
    flag_origin_check: "jo'natish shahri taxminan aniqlandi - tekshiring",
    flag_dest_check: "manzil shahri taxminan aniqlandi - tekshiring",
    flag_weight: "og'irlik ko'rsatilmagan - standart 20t qo'yildi",
    flag_date: "olib ketish sanasi ko'rsatilmagan yoki o'tib ketgan - bugungi sana qo'yildi",
    flag_rate: "narx ko'rsatilmagan - \"kelishilgan\" deb joylandi",

    fb_email_not_found: "Bunday e-pochtali hisob topilmadi. Avval saytda roʻyxatdan oʻting yoki yozilishini tekshiring.",
    fb_invalid_password: "Parol notoʻgʻri.",
    fb_invalid_login_credentials: "E-pochta yoki parol notoʻgʻri. (Google yoki telefon orqali kirgansiz va parolingiz yoʻqmi? Avval saytda oʻrnating: Hisob va sozlamalar → Kirish va xavfsizlik.)",
    fb_user_disabled: "Bu hisob faolsizlantirilgan.",
    fb_token_expired: 'Seans tugadi - yana /link qiling.',
    fb_user_not_found: 'Bu hisob endi mavjud emas - yana /link qiling.',
    fb_generic: "Kirib boʻlmadi ({code}).",

    link_dm_only: "PIN kodingiz sir qolishi uchun menga shaxsiy xabar yozing (ismimni bosing, keyin «Xabar yozish»).",
    link_usage: "/link yuboring, soʻng telefon raqamingiz va PIN kodingizni (4-6 raqam) kiriting.\nYoki bitta xabarda: /link +998901234567 482915\n\nHisobingiz yoʻqmi? Avval SNG ONE saytida telefon raqamingiz bilan hisob yarating, soʻng qaytib keling. (E-pochta bilan roʻyxatdan oʻtgansiz? /linkemail your@email.com parol buyrugʻidan foydalaning.)",
    link_email_usage: "Foydalanish: /linkemail your@email.com parol\n\n(Saytga kirish uchun ishlatadigan e-pochta va parolingiz. Telefon orqali kirasizmi? /link dan foydalaning.)",
    link_ask_phone: "SNG ONE hisobingizning telefon raqamini yuboring yoki Telegram raqamingizni ulashish tugmasini bosing. (/cancel — bekor qilish)",
    link_share_phone: "📱 Raqamimni ulashish",
    link_contact_not_yours: "Bu sizning raqamingiz emas. SNG ONE hisobingizning telefon raqamini yozing.",
    link_bad_phone: "Bu telefon raqamiga oʻxshamaydi. Davlat kodi bilan yuboring, masalan +998901234567.",
    link_ask_pin: "Endi PIN kodingizni (4-6 raqam) yuboring. Xabaringizni darhol oʻchirib qoʻyaman.",
    link_bad_pin: "PIN 4 tadan 6 tagacha raqamdan iborat. Qayta urinib koʻring yoki /cancel.",
    link_pin_wrong: "Telefon raqami yoki PIN notoʻgʻri. Qayta urinib koʻring yoki /cancel.\n\nUnutdingizmi? Platforma egasidan parolni tiklashni soʻrang.",
    link_pin_wrong_final: "Telefon raqami yoki PIN notoʻgʻri. Qaytadan boshlash uchun /link yuboring.",
    link_pin_locked: "Juda koʻp xato urinish. {min} daqiqadan soʻng urinib koʻring yoki platforma egasidan parolni tiklashni soʻrang.",
    link_blocked: "Bu hisob bloklangan. Platforma egasi bilan bogʻlaning.",
    link_cancelled: "Bekor qilindi.",
    link_unreachable: 'Hozir birjaga ulanib boʻlmadi - birozdan soʻng qayta urinib koʻring.',
    link_unverified: 'E-pochtangiz hali tasdiqlanmagan. Yuborilgan xatdagi tasdiqlash havolasini oching (“Spam” ni ham tekshiring), soʻng yana /link yuboring.',
    link_no_account: "Bu raqam uchun SNG ONE hisobi yoʻq. Avval saytda roʻyxatdan oʻting, soʻng yana /link yuboring.",
    link_not_approved: "Bu hisobni hozir ulab boʻlmaydi (holat: {status}).",
    link_success: '{company} sifatida ulandingiz ✅\n\nEndi shunchaki yuk postini joylang - men uni eʼlonlarga aylantiraman.',
    unlink_done: 'Uzildi. Telegram hisobingiz endi birjadagi hech bir aʼzo nomidan joylamaydi.',
    unlink_none: 'Siz ulanmagan edingiz.',
    mystatus_none: "Ulanmagan. /link yuboring (shaxsiy xabarda).",
    mystatus_linked: "{company} ({login}) sifatida ulangansiz - holat: {status}.",

    myloads_dm_only: 'Menga shaxsiy xabar yozib, u yerda /myloads yuboring.',
    myloads_empty: "Siz hali birorta yuk joylamagansiz.",
    myloads_header: 'Sizning yuklaringiz ({count}):',
    myloads_btn_delete: "🗑 O'chirish",
    myloads_confirm: "Bu yukni birjadan va yetib borgan barcha chatlardan o'chirilsinmi?",
    myloads_btn_yes: "Ha, o'chirish",
    myloads_btn_no: "Yo'q",
    myloads_cancelled: "Qoldirildi - o'chirilmadi.",
    myloads_deleted: "✅ O'chirildi.",
    myloads_delete_failed: "O'chirib bo'lmadi - keyinroq qayta urinib ko'ring.",

    paste_dm_only: "Menga shaxsiy xabar yozing (ismimni bosing, keyin «Xabar yozish») va matnni u yerga joylang - joylashda aloqa maʼlumotlaringiz kerak boʻlishi mumkin.",
    paste_not_linked: "Hali ulanmagansiz. Avval /link yuboring, soʻng matnni qayta joylang.",
    paste_session_error: "Seans tugadi (masalan, PIN oʻzgartirilgan) - yana /link qiling, soʻng matnni qayta joylang.",
    paste_not_approved: 'Hozircha hisobingiz yuk joylashga tasdiqlanmagan.',
    paste_unreachable: 'Hozir birjaga ulanib boʻlmadi - birozdan soʻng qayta urinib koʻring.',
    paste_parsing: '🤖 Matnni oʻqiyapman…',
    paste_ai_unavailable: 'AI import hali serverda sozlanmagan - platforma egasidan GEMINI_API_KEY ni sozlashini soʻrang.',
    paste_ai_busy: 'AI import hozir band, yoki soatlik limitingizga yetdingiz - birozdan soʻng qayta urinib koʻring.',
    paste_bad_output: 'AI kutilmagan formatda javob berdi - qayta urinib koʻring.',
    paste_no_loads_found: "Bu matnda yuk topa olmadim. Yuk posti joylang (yoʻnalish, mashina turi, yuk, sanalar) - men ajratib beraman.",
    paste_truncated_note: '(bu matndan faqat birinchi {max} ta yuk oʻqildi - qolganini alohida joylang)',
    paste_found_header: '📦 Bu matndan {count} ta yuk topildi:',
    paste_skip_note: "\n🚫 {count} tasi oʻtkazib yuboriladi - shahar aniqlanmadi. Yozilishini tuzatib, shu yukni qayta joylang.",
    paste_ready_footer: '\nJoylashga tayyor: {total} tadan {postable} ta.',
    paste_btn_post: '✅ {count} ta yukni joylash',
    paste_btn_cancel: '❌ Bekor qilish',
    paste_cancelled: 'Bekor qilindi - hech narsa joylanmadi.',
    paste_expired: 'Bu toʻplam eskirdi - matnni qayta joylang.',
    paste_nothing_postable: "Bu yuklarning birortasini joylab boʻlmadi (shahar aniqlanmadi) - yozilishini tuzatib qayta joylang.",
    paste_posted_header: '✅ {count} ta yuk joylandi - birjada:',
    paste_post_failed: 'Joylab boʻlmadi: {message}',
    paste_post_failed_generic: 'Joylab boʻlmadi - keyinroq qayta urinib koʻring.',
    paste_subscription_required: "Bepul sinov davri yoki obuna tugadi, shuning uchun eʼlon joylash yopiq. Toʻlov qiling — platforma egasi qayta ochadi; batafsil saytda, «Hisob va sozlamalar».",
    paste_contact_missing: "Profilingizda telefon yoki Telegram yoʻq, va bu matnda ham yoʻq, shuning uchun bu yuklar uchun koʻrsatadigan aloqa maʼlumoti qolmadi. Saytda profilingizga telefon yoki Telegram qoʻshing-da, matnni qayta joylang.",
  },
};

export function pickLang(telegramLanguageCode) {
  const code = String(telegramLanguageCode ?? '').toLowerCase();
  if (code.startsWith('ru')) return 'ru';
  if (code.startsWith('uz')) return 'uz';
  return DEFAULT_LANG;
}

export function t(lang, key, vars) {
  const dict = DICT[lang] ?? DICT[DEFAULT_LANG];
  let s = dict[key] ?? DICT[FALLBACK_LANG][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
