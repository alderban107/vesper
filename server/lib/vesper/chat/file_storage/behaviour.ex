defmodule Vesper.Chat.FileStorage.Behaviour do
  @moduledoc """
  Behaviour for file storage backends.

  Implementations:
  - `Vesper.Chat.FileStorage.Local` — local filesystem (default, self-hosted)
  - Future: SFTP/SSH, S3-compatible, etc.
  """

  @type storage_key :: String.t()

  @doc "Store a file from a local source path. Returns a storage key."
  @callback store(source_path :: String.t(), original_filename :: String.t()) ::
              {:ok, storage_key()} | {:error, term()}

  @doc "Get the path or URL for a stored file."
  @callback get_path(storage_key()) :: String.t()

  @doc "Delete a stored file."
  @callback delete(storage_key()) :: :ok

  @doc "Maximum allowed upload size in bytes."
  @callback max_upload_size() :: non_neg_integer()

  @doc "Store a server emoji file."
  @callback store_server_emoji(
              source_path :: String.t(),
              server_id :: String.t(),
              storage_key()
            ) :: :ok | {:error, term()}

  @doc "Delete a server emoji file."
  @callback delete_server_emoji(server_id :: String.t(), storage_key()) :: :ok

  @doc "Delete existing avatar files for a user."
  @callback delete_existing_avatar(user_id :: String.t()) :: :ok

  @doc "Delete existing banner files for a user."
  @callback delete_existing_banner(user_id :: String.t()) :: :ok

  @doc "Delete existing server icon files."
  @callback delete_existing_server_icon(server_id :: String.t()) :: :ok

  @doc "Get the avatar directory path."
  @callback avatar_dir() :: String.t()

  @doc "Get the banner directory path."
  @callback banner_dir() :: String.t()

  @doc "Get the server icon directory path."
  @callback server_icon_dir() :: String.t()

  @doc "Get the emoji directory path for a server."
  @callback emoji_dir(server_id :: String.t()) :: String.t()

  @doc "Get the emoji file path."
  @callback emoji_path(server_id :: String.t(), storage_key()) :: String.t()
end
