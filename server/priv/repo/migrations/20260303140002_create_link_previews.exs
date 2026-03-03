defmodule Vesper.Repo.Migrations.CreateLinkPreviews do
  use Ecto.Migration

  def change do
    create table(:link_previews, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :url_hash, :string, size: 64, null: false
      add :url, :text, null: false
      add :title, :string
      add :description, :text
      add :image_url, :text
      add :site_name, :string
      add :fetched_at, :utc_datetime, null: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:link_previews, [:url_hash])
  end
end
