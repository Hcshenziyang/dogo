diesel::table! {
    accounts (id) {
        id -> Text,
        username -> Text,
        password_hash -> Text,
        active -> Bool,
        created_at -> BigInt,
    }
}

diesel::table! {
    devices (id) {
        id -> Text,
        account_id -> Text,
        name -> Text,
        kind -> Text,
        active -> Bool,
        token_version -> BigInt,
        refresh_hash -> Nullable<Text>,
        refresh_expires_at -> Nullable<BigInt>,
        created_at -> BigInt,
    }
}

diesel::joinable!(devices -> accounts (account_id));
diesel::allow_tables_to_appear_in_same_query!(accounts, devices);
