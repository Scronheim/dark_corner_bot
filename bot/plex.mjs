import axios from 'axios'

const API_URL = process.env.API_URL

class PlexApi {
  constructor(token) {
    this.plex = axios.create({
      baseURL: API_URL,
      method: 'GET',
      params: {'X-Plex-Token': token},
      headers: {
        Accept: 'application/json'
      }
    })
  }

  search = async (query) => {
    const artistsResponse = await this.plex.get(`/hubs/search?query=${query}&sectionId=1`)
    return artistsResponse.data.MediaContainer.Hub.find(h => h.type === 'artist')
  }

  searchById = async (id) => {
    const { data } = await this.plex.get(`/library/metadata/${id}`)
    const response = data.MediaContainer.Metadata[0]
    const albums = (await this.plex.get(response.key)).data.MediaContainer.Metadata
    response.albums = albums
    return response
  }

  searchByArtistTitle = async (title) => {
    const { data } = await this.plex.get(`/library/sections/1/all?title=${title}`)
    return data.MediaContainer.Metadata[0] 
  }

  getIdChildren = async (id) => {
    const { data } = await this.plex.get(`/library/metadata/${id}/children`)
    return data.MediaContainer.Metadata
  }

  getLastAlbums = async (limit) => {
    const { data } = await this.plex.get(`/library/recentlyAdded?limit=${limit}`)
    return data.MediaContainer.Metadata
  }

  refreshLibrary = async () => {
    await this.plex.get(`${API_URL}/library/sections/1/refresh`)
  }
}

export default PlexApi
